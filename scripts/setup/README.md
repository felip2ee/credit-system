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

O instalador só instala uma versão fixa: uma tag ou o SHA completo (40 caracteres) de um commit da `main`.

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

## 5. Atualizar

Repita o passo 2 com o SHA novo e cole o mesmo comando do passo 3. O instalador reaproveita a configuração e os secrets, troca só a imagem e refaz a verificação. Sem mudança, nada muda.

Antes de uma atualização com migration nova, rode o backup manual.

## 6. Se der errado

- O instalador mostra as últimas linhas do serviço com falha. Leia a mensagem: ela diz o que corrigir.
- Falha na migração ou no app: ele volta sozinho para a versão anterior (não na primeira instalação).
- Falha só de certificado, DNS ou `/login`: nada é revertido. Corrija a causa (DNS, Traefik) e rode o comando de novo.
- Para ver o plano sem mudar nada: acrescente `--dry-run` no fim do comando, depois de `"$d/install.sh"`.
- Logs: `docker service logs reino_reino_app` (app), `docker service logs reino_migrate` (migração).
