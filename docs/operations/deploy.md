# Deploy de produção

Runbook do primeiro deploy e das atualizações. O deploy é manual: o operador roda os passos no servidor. O CI não acessa o servidor (decisão D9 do [spec do M7](../superpowers/specs/2026-10-16-m7-producao-design.md)).

Itens marcados **(post-deploy)** só a produção confirma. O PR do M7 lista-os como follow-up.

## 1. Pré-requisitos

| Item | Requisito |
|---|---|
| Servidor | Linux com Docker Engine e Docker Compose. Um nó manager do Swarm. |
| Swarm | `docker swarm init` feito. `reino_app` e `reino_migrate` têm placement no manager. |
| Rede | Rede overlay do Traefik (`TRAEFIK_NETWORK`, padrão `RainhaNet`) e o resolver `letsencryptresolver`. |
| DNS | `<APP_DOMAIN>` aponta para o servidor. |
| Disco | Volumes `postgres_data`, `documents`, `clamav_data`, `backup_state` e `backup_work`. Dimensione pelo banco e pelo volume de documentos. |
| Imagens | Digests de `reino-credito` e `reino-backup` publicados no GHCR pelo workflow `docker-image.yml`. |
| SMTP | Credenciais de envio. O app e o cron de alertas usam o mesmo SMTP. |
| Bucket S3 | Passo 2. |

## 2. Criar o bucket S3

O repositório Restic fica fora do servidor, em um bucket S3-compatível (D1).

1. Crie um bucket só para o backup: `<bucket>`.
2. Proteja o histórico contra a chave do servidor. Uma chave que apaga objetos também apaga versões, e o R2 não tem versionamento clássico. Use Object Lock (modo governance ou compliance, retenção de 30 dias ou mais) **ou** uma política de chave/bucket que negue `s3:DeleteObjectVersion`, `s3:PutLifecycleConfiguration` e `s3:PutBucketVersioning`.
3. Bloqueie todo acesso público. Não use ACL pública.
4. Crie uma chave de acesso com escopo mínimo: só o bucket `<bucket>`.
5. Guarde o endpoint (`<RESTIC_S3_ENDPOINT>`, sem `https://`), o nome do bucket e as duas partes da chave. O setup pede esses valores no passo 3.

O container de backup grava e apaga objetos no bucket. O Object Lock ou a política de negação é a defesa contra apagamento (D14). Com isso ativo, `restic forget --prune` exige retenção compatível com o bloqueio (`keep-*` não menor que o período do lock) ou uma credencial separada.

## 3. Gerar segredos e o arquivo de ambiente

Na raiz do repositório, no servidor:

```sh
python3 scripts/setup/setup_production.py
```

O script pede os valores e as senhas (entrada oculta). Ele:

- cria os 22 secrets do Docker (a lista está na seção `secrets` de `docker-stack.yml`);
- grava `.env.production` com as variáveis não secretas, inclusive `RESTIC_S3_ENDPOINT`, `RESTIC_S3_BUCKET` e `OPS_ALERT_TO`;
- grava `credenciais-GUARDAR.txt` com as senhas geradas e as duas chaves S3.

Depois do setup:

1. Guarde `credenciais-GUARDAR.txt` em um gerenciador de senhas.
2. Apague `credenciais-GUARDAR.txt` do servidor.
3. Não versione `.env.production`.

## 4. Primeiro deploy

1. Carregue as variáveis no shell, sem imprimi-las:

   ```sh
   set -a; . ./.env.production; set +a
   ```

2. Faça o deploy da stack. O nome `reino` gera os serviços `reino_app`, `reino_migrate` e `reino_backup`:

   ```sh
   docker stack deploy --with-registry-auth -c docker-stack.yml reino
   ```

   Use `--with-registry-auth` se o pacote no GHCR for privado.

3. Confirme a migração. O serviço `migrate` roda uma vez e termina:

   ```sh
   docker service ps reino_migrate
   ```

   O estado deve ser `Complete`. Se houver `Failed` ou retentativas, leia `docker service logs reino_migrate`.

   Se o `migrate` ficar em `Failed` (por exemplo, o Postgres demorou a iniciar), force uma nova execução:

   ```sh
   docker service update --force reino_migrate
   ```

4. Confirme o app:

   ```sh
   docker service logs reino_app
   ```

   Procure a linha `Ready`. Antes disso, o app espera o schema com `migrate.mjs --check`: tenta até 30 vezes, com 5 s de intervalo. Se o schema não ficar pronto, o app sai com erro e o Swarm o reinicia. O healthcheck tem `start_period` de 160 s para cobrir essa espera.

5. Faça o primeiro backup manual. Confirme o snapshot no bucket:

   ```sh
   docker exec $(docker ps -q -f name=reino_backup) /opt/backup/backup.sh
   ```

   **(post-deploy)**

6. Rode o drill de restauração. Ele restaura o último snapshot em um cluster isolado e envia o resultado por e-mail (`BACKUP_ALERT_TO`):

   ```sh
   docker exec $(docker ps -q -f name=reino_backup) /opt/backup/restore-test.sh
   ```

   Anote a duração medida. O runbook de recuperação ainda não existe. **(post-deploy)**

7. Ative a limpeza LGPD do Bureau depois que o jurídico aprovar os prazos de retenção. Defina `LGPD_PURGE_ENABLED=1` em `.env.production` e repita o `docker stack deploy` do passo 4.2. O padrão é `0` (desligado). Veja [lgpd.md](lgpd.md), seção 5. **(post-deploy)**

8. Configure o monitor externo. Veja [monitoring.md](monitoring.md), seção 3. **(post-deploy)**

9. Assine o [checklist de segurança](security-checklist.md) com evidência fora do repositório. **(post-deploy)**

## 5. Atualização

Cada deploy usa digest. A configuração recusa tag ou `latest`.

1. Copie os dois digests do job summary do workflow `docker-image.yml`: `reino-credito` e `reino-backup`.
2. Atualize `REINO_IMAGE_DIGEST` e `REINO_BACKUP_DIGEST` em `.env.production`.
3. Repita o passo 4.1 e o `docker stack deploy` do passo 4.2.
4. Confirme `reino_migrate` em `Complete` e `reino_app` em `Ready`.

O serviço `migrate` roda a cada deploy. As migrations já aplicadas não rodam de novo: o runner confere o checksum. Um `pg_advisory_lock` impede duas execuções ao mesmo tempo (D10).

Antes de um deploy com migration nova, rode o backup manual do passo 4.5.

## 6. Rollback

- Para voltar o app à imagem anterior:

  ```sh
  docker service rollback reino_app
  ```

- Migrations não voltam. Depois do primeiro deploy, `db/migrations/` é forward-only.
- Se a imagem anterior não roda com o schema novo, o rollback do app não basta. Restaure o banco a partir do snapshot Restic. Este runbook não descreve a restauração completa. O drill (`restore-test.sh`) restaura em cluster isolado e não substitui o procedimento de recuperação (lacuna conhecida).

## Referências

- [Monitoramento e alertas](monitoring.md)
- [LGPD: retenção e pedidos do titular](lgpd.md)
- [Checklist de segurança](security-checklist.md)
- [Notificações](notifications.md)
- [Pedidos de pesquisa](orders.md)
