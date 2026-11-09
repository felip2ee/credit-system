# Instalar a plataforma no servidor

Guia do operador. Um comando colado no terminal do servidor (Termius) instala ou atualiza a plataforma e confirma que ela está no ar. O detalhe de cada passo está em [docs/operations/deploy.md](../../docs/operations/deploy.md), seção "Instalação com um comando".

## 1. Antes de começar

Tenha em mãos:

| Item | Onde conseguir |
|---|---|
| Servidor Linux (Ubuntu ou Debian) com acesso root por SSH | Seu provedor de VPS |
| Domínio apontando para o IP do servidor (registro A) | Painel do seu DNS |
| Token do GitHub para o código: PAT fine-grained, só leitura, permissão `Contents: read` neste repositório | GitHub → Settings → Developer settings → Fine-grained tokens |
| Token do GitHub para as imagens: token classic só com `read:packages` | GitHub → Settings → Developer settings → Tokens (classic) |
| Dados de SMTP (host, porta, usuário, senha, remetente) | Seu provedor de e-mail |
| E-mail do superadmin (a senha é gerada) | Você define |
| Credenciais da API DEPS e chave da OpenAI | Fornecedores |
| Bucket S3 para backup (endpoint, nome, chave de acesso e chave secreta) | [deploy.md, seção 2](../../docs/operations/deploy.md#2-criar-o-bucket-s3) |

Opcional: WhatsApp (Meta Cloud API): ID do número, token de sistema e app secret da Meta.

O instalador pergunta só o que ele não gera nem detecta. Ele gera sozinho: a senha do superadmin, o `whatsapp_verify_token` e as chaves VAPID do push (com o `openssl` do servidor). As senhas digitadas usam entrada oculta. O backup S3 é obrigatório, porque a stack exige endpoint e bucket.

## 2. Escolher a versão

O instalador só instala uma versão fixa: o SHA completo (40 caracteres minúsculos) de um commit da `main`, ou uma tag no formato `refs/tags/<nome>` (ex.: `refs/tags/v1.0.0`). Nomes soltos (`main`, `develop`, `feature/x`, `refs/heads/*`, `origin/*`, `refs/pull/*`) são recusados. `latest-main` só existe com `--update` (seção 5).

1. No GitHub, abra a `main` e copie o SHA completo do commit que você quer publicar.
2. Confira que o workflow **Build and push images** desse commit terminou com sucesso (aba Actions). Ele roda a cada merge na `main` e publica as imagens com esse SHA. Sem isso, o instalador não acha a imagem.

## 3. Instalar

Cole no terminal do servidor, trocando `<SHA>` pelo valor do passo 2:

```sh
export CS_REF='<SHA>'; read -rsp 'Token GitHub (só contents:read): ' CS_GH_TOKEN; echo; export CS_GH_TOKEN; d=$(mktemp -d) && printf 'header = "Authorization: Bearer %s"\n' "$CS_GH_TOKEN" | curl -fsSL -K - -o "$d/install.sh" "https://raw.githubusercontent.com/felip2ee/credit-system/$CS_REF/scripts/setup/install.sh" && sudo --preserve-env=CS_GH_TOKEN,CS_REF bash "$d/install.sh"; rm -rf "$d"; unset CS_GH_TOKEN
```

O que acontece:

1. Pede o token do código (entrada oculta) e baixa o repositório em `/opt/credit-system`.
2. Pede o token das imagens (`read:packages`).
3. Detecta o que já existe: Docker, Swarm, Traefik, rede, certificado e a stack `reino`. Instala só o que falta e pergunta antes de cada passo que muda o servidor.
4. Pergunta domínio, SMTP, e-mail do superadmin, DEPS, OpenAI e S3, e duas opções: `Ativar WhatsApp (Meta Cloud API)? [s/N]` e `Ativar notificações push no portal? [S/n]`. Os e-mails de alerta usam o do superadmin como padrão (Enter aceita). Se o `openssl` faltar, o instalador pede as duas chaves VAPID.
5. Imprime uma linha `✔ <etapa>` a cada passo (ou `✘ <etapa>: <motivo>`). Publica a stack e verifica: migração concluída, app no ar, `/api/health/live` e `/api/health/ready` com 200, certificado válido, `/login` com 200.
6. Mostra `PRONTO` com a URL. Se o DNS ainda não aponta para o servidor, mostra "app OK localmente; DNS ainda não aponta para este servidor".

Se já existe outro programa nas portas 80 ou 443 (nginx, apache), o instalador para e explica. Ele não disputa a porta.

## 4. Depois da instalação

1. No fim de uma execução com sucesso, o instalador imprime um bloco `CREDENCIAIS DESTA EXECUÇÃO` com todas as senhas geradas. Salve o bloco em um gerenciador de senhas agora. Ele não é mostrado de novo.
   - Depois ele pergunta `Credenciais salvas? Apagar o arquivo <caminho> agora? [s/N]`. Responda `s` para apagar o arquivo do servidor.
   - Com `--yes`, o arquivo não é apagado. Apague-o à mão.
   - O instalador grava o arquivo antes de imprimir (`/root/credit-system-credentials/credenciais-<data>-GUARDAR.txt`). Ele existe só para que nada se perca se a sessão SSH cair antes da impressão.
   - Numa execução com falha, nenhuma senha é impressa.
2. Entre em `https://<seu-domínio>/login` com o superadmin.
3. Faça o primeiro backup manual e os demais itens **(post-deploy)** de [deploy.md, seção 4](../../docs/operations/deploy.md#4-primeiro-deploy).

## 5. Atualizar (um comando)

Para uma plataforma já instalada, cole este comando no Termius. Ele não pede de novo domínio, SMTP, DEPS, OpenAI, S3, superadmin, WhatsApp nem push: reaproveita o `.env.production` e os secrets. Pode rodar quantas vezes quiser (idempotente).

```sh
read -rsp 'Token GitHub (só contents:read): ' CS_GH_TOKEN; echo; export CS_GH_TOKEN; d=$(mktemp -d) && printf 'header = "Authorization: Bearer %s"\n' "$CS_GH_TOKEN" | curl -fsSL -K - -o "$d/install.sh" "https://raw.githubusercontent.com/felip2ee/credit-system/main/scripts/setup/install.sh" && sudo --preserve-env=CS_GH_TOKEN bash "$d/install.sh" --update; rm -rf "$d"; unset CS_GH_TOKEN
```

Sem `CS_REF`, o `--update` usa o commit atual da `main` (resolvido com `git ls-remote`, só com o token `contents:read`). Isso é `latest-main`: **uso consciente**. Duas coisas que ele não garante:

- A imagem publicada **não prova CI verde**. O workflow que publica a imagem não espera os testes. Confira o CI (aba Actions) do commit antes de usar `latest-main`.
- O `install.sh` vem da `main` e roda como root. Quem escreve na `main` controla o servidor (supply chain). Proteja a `main` no GitHub: branch protection com revisão obrigatória e sem push direto.

Para travar uma versão, fixe `CS_REF` por SHA no comando curto: `export CS_REF='<SHA completo>'` antes do comando, troque `main` na URL por `$CS_REF` e acrescente `CS_REF` ao `--preserve-env`. Com `CS_REF` por SHA, nada muda se alguém publicar na `main` depois. Pede ainda o token das imagens (`read:packages`); Enter vale para imagens públicas.

Só um instalador roda por vez (`flock` em `/var/lock/credit-system-install.lock`); uma segunda execução para com mensagem clara.

O que acontece, em ordem:

1. Detecta a stack `reino`, o `.env.production`, os secrets e o Traefik. Se a instalação está completa, reaproveita tudo. Sem `--update`, ele oferece `Atualizar agora, reaproveitando tudo? [S/n]`.
2. Acha o digest das imagens do commit. Se a imagem desse commit ainda não existe no GHCR (o workflow **Build and push images** não terminou, ou falhou), ele para **antes de mudar qualquer coisa**. Espere o workflow e rode de novo.
3. Mostra o resumo: secrets a criar (por exemplo `pii_encryption_key`), variáveis a adicionar no `.env.production` (`PIX_FEE_CENTS=199`, `CARD_FEE_TABLE`, `CARD_MIN_INSTALLMENT_CENTS=500`), migrations novas e o commit que vai subir. Mostra também `CARD_FEE_TABLE` e a linha `cartão: será LIGADO` (ou `DESLIGADO`). Pede um único confirma: `[S/n]` se não há migration nova; **`[s/N]` (padrão NÃO, digite `s`) se há migration nova ou a versão atual é desconhecida**, porque migrations não voltam. Com `--yes`, se pode haver migration, ele só roda com `--confirm-backup` (ou `CS_BACKUP_OK=1`): você afirma que o backup é recente. Sem isso ele para antes de mudar qualquer coisa.
4. Cria só o secret que falta (nunca troca um existente). O valor é gravado em `/root/credit-system-credentials/credenciais-novos-<data>-GUARDAR.txt` **antes** de o secret ser criado no Docker (se a gravação falha, nada é criado; se a criação falha, ele desfaz e remove o arquivo, e o valor nunca é impresso em falha). Arquivos antigos nunca são sobrescritos (sufixo `-2`, `-3`). No início e no fim ele lista os `credenciais-novos-*` de execuções anteriores: uma execução que falhou pode ter deixado ali a chave PII. O valor é impresso no bloco final.
5. Antes de escrever, copia o `.env.production` para `.env.production.bak-<data>` (0600, nunca sobrescreve; ignorado pelo git) e confere `docker stack config` com as variáveis mescladas (variável obrigatória faltando para antes de criar qualquer secret). Acrescenta ao `.env.production` só as variáveis ausentes, com escrita atômica e sem mudar o fim de linha. Variável preenchida nunca muda. `PIX_FEE_CENTS` vazia vira `199`, com aviso. Valor inválido: ele pergunta (com `--yes`, para e pede correção).
6. Roda `docker stack deploy`. O serviço `reino_migrate` roda as migrations; o app novo só sobe com o schema pronto (ele espera `migrate.mjs --check`). O instalador espera o `reino_migrate` chegar a `Complete`, depois o app, depois health, TLS e `/login`.
7. Falha na migração ou no app: refaz o deploy com o `.env.production` anterior e o `docker-stack.yml` do commit anterior (`git show <CS_DEPLOYED_SHA>:docker-stack.yml`; se o SHA é desconhecido, usa o atual e avisa). Se o login do GHCR falha, tenta o deploy mesmo assim. Se não aplica, imprime `ROLLBACK NÃO APLICADO: produção está na versão nova ...` com o comando manual. Migrations não voltam.

A lista de migrations novas vem do diff de arquivos entre o commit anterior (gravado como `CS_DEPLOYED_SHA` no `.env.production` ao fim de cada execução com sucesso) e o novo. Na primeira atualização por este instalador o commit anterior é desconhecido: ele mostra só a última migration da versão e o `reino_migrate` aplica as pendentes.

Opções: `--update` (atualização rápida; exige instalação completa), `--yes` (sem perguntas), `--confirm-backup` (afirma backup recente; libera `--yes` com migrations), `--dry-run` (só mostra o resumo). Antes de uma atualização com migration nova, rode o backup manual.

**Caminho manual** (sem o instalador, `docker stack deploy` à mão): exporte também as variáveis novas (`PIX_FEE_CENTS`, `CARD_FEE_TABLE`, `CARD_MIN_INSTALLMENT_CENTS`) além do `.env.production`; sem `PIX_FEE_CENTS` o deploy falha (`${PIX_FEE_CENTS:?}`).

### Portainer

A stack `reino` foi criada por `docker stack deploy`, então o Portainer a mostra como stack **externa** (limitada). Isso é normal.

- Pode: ver serviços, tarefas, logs e o estado de cada réplica.
- Não edite o compose pelo editor do Portainer, não clique em "Update the stack" nem recrie a stack por lá. A fonte é o `docker-stack.yml` do repositório mais o `.env.production`; o Portainer não tem as variáveis nem os secrets e a stack falharia (`PIX_FEE_CENTS` e outras são obrigatórias).
- `docker stack deploy` do instalador atualiza a **mesma** stack: não a recria e não apaga volumes.
- Resultado das migrations: Portainer, Services, `reino_migrate`, aba Tasks (deve estar `complete`), depois Logs. No terminal: `docker service ps reino_migrate` e `docker service logs reino_migrate`.

### O que ainda é manual

Depois de uma atualização com o PR de pagamentos por pagador:

- Revisar `CARD_FEE_TABLE` no `.env.production` (valor real da conta: `1:2.99:49,6:2.99:49,12:2.99:49`; vazio desliga o cartão). Depois repita o comando.
- Guardar a chave PII (`pii_encryption_key`, do bloco de credenciais) no gerenciador de senhas. Sem ela, os dados cifrados do pagador ficam ilegíveis.
- Trocar a chave da API do Asaas (se ainda é a antiga).
- Teste real de cartão e de Pix com taxa, e o resto do checklist **(post-deploy)** de [payments.md, seção 7](../../docs/operations/payments.md#7-checagens-após-o-deploy).

## 6. Se der errado

- O instalador mostra as últimas linhas do serviço com falha. Leia a mensagem: ela diz o que corrigir.
- Falha na migração ou no app: ele volta sozinho para a versão anterior (não na primeira instalação).
- Falha só de certificado, DNS ou `/login`: nada é revertido. Corrija a causa (DNS, Traefik) e rode o comando de novo.
- Para ver o plano sem mudar nada: acrescente `--dry-run` no fim do comando, depois de `"$d/install.sh"`.
- Imagem do commit ainda não publicada: o instalador para antes de mudar o servidor. Espere o workflow e rode de novo.
- Logs: `docker service logs reino_reino_app` (app), `docker service logs reino_migrate` (migração).
