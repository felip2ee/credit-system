# Deploy de produção

Runbook do primeiro deploy e das atualizações. O deploy é manual: o operador roda os passos no servidor. O CI não acessa o servidor (decisão D9 do [spec do M7](../superpowers/specs/2026-10-16-m7-producao-design.md)).

Itens marcados **(post-deploy)** só a produção confirma. O PR do M7 lista-os como follow-up.

## Instalação com um comando

Um comando no Termius instala ou atualiza a plataforma e confirma que ela está no ar. Ele usa a mesma stack e os mesmos passos deste runbook. Os nomes reais dos serviços no Swarm são `<stack>_<chave do compose>`: com a stack `reino`, a chave `reino_app` vira `reino_reino_app`; `migrate`, `backup` e `notifications_cron` viram `reino_migrate`, `reino_backup` e `reino_notifications_cron`. O instalador descobre os nomes com `docker stack services reino`. Os passos 3 a 5 abaixo continuam valendo para quem prefere o caminho manual.

Cole no servidor Linux. Troque `<TAG_OU_SHA>` por uma tag ou pelo SHA completo (40 caracteres) de um commit que você revisou. O instalador não aceita branch (`main`). Os tokens são pedidos com entrada oculta e não vão na URL, no histórico nem em `ps`:

```sh
export CS_REF='<TAG_OU_SHA>'; read -rsp 'Token GitHub (só contents:read): ' CS_GH_TOKEN; echo; export CS_GH_TOKEN; d=$(mktemp -d) && printf 'header = "Authorization: Bearer %s"\n' "$CS_GH_TOKEN" | curl -fsSL -K - -o "$d/install.sh" "https://raw.githubusercontent.com/felip2ee/credit-system/$CS_REF/scripts/setup/install.sh" && sudo --preserve-env=CS_GH_TOKEN,CS_REF bash "$d/install.sh"; rm -rf "$d"; unset CS_GH_TOKEN
```

São **duas credenciais separadas**:

- Token do clone: PAT fine-grained, só leitura, permissão `contents:read` neste repositório. O `install.sh` o usa só no `git fetch` e o descarta.
- Token do GHCR: outro token (classic) só com `read:packages`. O `install.sh` o pede em seguida (vazio = imagens públicas). Ele é usado só no `docker login --password-stdin`, e o instalador roda `docker logout ghcr.io` logo depois do deploy e em qualquer falha.

Para travar o código exato, defina também `CS_EXPECTED_SHA` (40 caracteres). O `install.sh` imprime o `git rev-parse HEAD` antes de rodar e para se for outro commit. Como root, tire o `sudo --preserve-env=...`. Opções: `--dry-run` (só mostra o plano; não faz pull nem muda nada), `--yes` (aceita os padrões; só em atualização), `--update-only` (exige a stack já publicada).

**Supply chain.** O comando baixa `install.sh` do mesmo ref que vai instalar. Verifique o SHA do ref no GitHub antes de colar. `CS_REPO_URL` só aceita `https://github.com/<dono>/<repo>.git`.

**O que ele detecta e reaproveita**

- Docker: instala pelo script oficial só se faltar, depois de perguntar.
- Swarm: roda `docker swarm init` só se estiver inativo, depois de perguntar.
- Traefik: reconhece a imagem `traefik` (qualquer registry), lê a rede e o certresolver e os oferece como padrão. A rede precisa ser `overlay` de escopo `swarm`; senão ele a descarta e avisa. Avisa também se não vê o provider swarm ou o entrypoint `websecure`. Com `--yes`, para se houver mais de uma rede ou resolver candidatos. Se não houver Traefik, oferece publicar um mínimo (Traefik v3, provider `swarm`, tag `traefik:v3.5`: confirme com `docker pull traefik:v3.5` no servidor). A stack mínima monta `/var/run/docker.sock` somente leitura: quem controla o Traefik alcança o Docker; um socket-proxy é opcional e não é exigido agora.
- Stack `reino` ou `.env.production` existentes: é uma atualização. Ele reaproveita o `.env.production` e os secrets, cria só os que faltam e nunca troca um secret existente. Ele para se só parte dos secrets do banco existe, se não há secrets do banco mas existe um volume `*_postgres_data`, ou se falta só o `restic_password` (uma senha nova tornaria os backups ilegíveis). Se a criação dos secrets falha no meio, ele apaga os secrets criados nessa execução e os arquivos gerados.
- Portas 80/443 ocupadas por outro programa (nginx, apache): ele para com instruções e não disputa a porta. Se o `ss` falha, ele avisa que não conseguiu verificar.
- Postgres no host: ignorado. A stack usa o Postgres próprio.
- Digests: resolve `reino-credito` e `reino-backup` no GHCR para o commit publicado. Você pode trocar o valor.
- DNS: compara `APP_DOMAIN` com o IP público do servidor. Em caso de diferença, avisa e deixa continuar. Nesse caso o resumo final não diz "PRONTO": diz "app OK localmente; DNS ainda não aponta para este servidor".

**O que ele verifica depois do deploy**

1. `reino_migrate` chega a `Complete`.
2. `reino_reino_app` converge (réplicas rodando, sem loop de reinício, sem rollback do Swarm).
3. `https://<APP_DOMAIN>/api/health/live` e `/api/health/ready` respondem 200.
4. O certificado TLS é válido e não é o padrão do Traefik.
5. `/login` responde 200.

As etapas 3 a 5 conectam em `127.0.0.1:443` com SNI e `Host` iguais a `APP_DOMAIN` e verificam o certificado de forma estrita. Elas não dependem do DNS. Cada etapa tem timeout e mostra uma linha de progresso.

**Rollback.** Só a falha da migração ou da convergência do app (etapas 1 e 2) dispara rollback. O instalador mostra as últimas 40 linhas do serviço com falha (sem segredos), restaura o texto antigo do `.env.production` e refaz o `docker stack deploy` com ele (todos os serviços, idempotente). Ele não usa `docker service rollback`. Se o Swarm já reverteu o app (`rollback_started` ou `rollback_completed`), ele avisa e só alinha os outros serviços. Sem rollback: primeira instalação (não há versão anterior; a stack fica no ar para inspeção) e digest novo igual ao anterior. Falha só de health, TLS ou `/login` não reverte nada: o instalador mostra o diagnóstico (DNS, logs do Traefik, rede e resolver) e você roda de novo depois de corrigir. Se o próprio `docker stack deploy` falha, ele restaura o `.env.production` e para. Migrations não voltam (seção 6).

**Atualizar.** Rode o mesmo comando de novo. Sem mudança, nada muda. Com imagem nova, ele troca só os digests e refaz a verificação. Rode o backup manual (passo 4.5) antes de uma migration nova.

Credenciais e a stack do Traefik ficam fora do git, em `/root/credit-system-credentials/` (modo 0700, arquivos 0600): `credenciais-<data>-GUARDAR.txt` (primeira instalação), `credenciais-novos-<data>-GUARDAR.txt` (secrets criados numa atualização; arquivos antigos nunca são sobrescritos) e `traefik-stack.yml`. O `.env.production` fica na raiz do repositório, onde a stack o lê. O instalador pergunta só o que não consegue gerar ou detectar. WhatsApp e push são opcionais, com uma pergunta sim/não cada. Desligados, os secrets recebem os marcadores `whatsapp-disabled` e `push-disabled` (o Swarm recusa secret vazio). A senha do superadmin, o `whatsapp_verify_token` e o par VAPID são gerados. Os e-mails de alerta (`BACKUP_ALERT_TO`, `OPS_ALERT_TO`) usam o do superadmin como padrão. O backup S3 continua obrigatório (`docker-stack.yml`). Cada passo do instalador imprime uma linha `✔ <etapa>` (ou `✘ <etapa>: <motivo>` se falhar). Numa execução com sucesso, o instalador imprime no terminal um bloco com todas as credenciais geradas (o mesmo conteúdo do arquivo; nunca os tokens do GitHub) e pergunta `Credenciais salvas? Apagar o arquivo <caminho> agora? [s/N]`. Responda `s` só depois de salvar o bloco em um gerenciador de senhas. Com `--yes`, o instalador não apaga o arquivo e mostra o caminho. Numa execução com falha, nenhuma credencial é impressa. Os itens **(post-deploy)** do passo 4 (backup, drill, monitor, checklist) continuam manuais.

## 1. Pré-requisitos

| Item | Requisito |
|---|---|
| Servidor | Linux com Docker Engine e Docker Compose. Um nó manager do Swarm. |
| Swarm | `docker swarm init` feito. `reino_reino_app` e `reino_migrate` têm placement no manager. |
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

- cria os 23 secrets do Docker (a lista está na seção `secrets` de `docker-stack.yml`);
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

2. Faça o deploy da stack. O nome `reino` gera os serviços `reino_reino_app` (chave `reino_app` do compose), `reino_migrate` e `reino_backup`. Confira com `docker stack services reino`:

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
   docker service logs reino_reino_app
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
4. Confirme `reino_migrate` em `Complete` e `reino_reino_app` em `Ready`.

O serviço `migrate` roda a cada deploy. As migrations já aplicadas não rodam de novo: o runner confere o checksum. Um `pg_advisory_lock` impede duas execuções ao mesmo tempo (D10).

Antes de um deploy com migration nova, rode o backup manual do passo 4.5.

## 6. Rollback

- Para voltar o app à imagem anterior:

  ```sh
  docker service rollback reino_reino_app
  ```

- Migrations não voltam. Depois do primeiro deploy, `db/migrations/` é forward-only.
- Se a imagem anterior não roda com o schema novo, o rollback do app não basta. Restaure o banco a partir do snapshot Restic. Este runbook não descreve a restauração completa. O drill (`restore-test.sh`) restaura em cluster isolado e não substitui o procedimento de recuperação (lacuna conhecida).

## Referências

- [Monitoramento e alertas](monitoring.md)
- [LGPD: retenção e pedidos do titular](lgpd.md)
- [Checklist de segurança](security-checklist.md)
- [Notificações](notifications.md)
- [Pedidos de pesquisa](orders.md)
