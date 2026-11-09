#!/usr/bin/env bash
# Bootstrap do instalador: baixa o repositório numa versão FIXA em /opt/credit-system e chama install.py.
# Uso:  sudo bash install.sh [--dry-run] [--yes] [--confirm-backup] [--update-only] [--update]
# Variáveis:
#   CS_REF            SHA completo (40 hex minúsculos) ou tag no formato refs/tags/<nome>. Nunca um branch (develop,
#                     feature/x, refs/heads/*, origin/*, refs/pull/*). 'latest-main' (ou CS_REF vazio) SÓ vale com --update:
#                     usa o commit atual da main (git ls-remote), uso consciente: a imagem publicada NÃO prova CI verde.
#                     O install.py só segue se a imagem desse commit já existir no GHCR.
#   CS_BACKUP_OK=1    (ou --confirm-backup) afirma backup recente: libera --yes quando há migrations pendentes.
#   CS_EXPECTED_SHA   opcional: o script para se o commit baixado for outro.
#   CS_GH_TOKEN       PAT fine-grained só leitura (contents:read) para o git clone. Pede com entrada oculta se faltar.
#   CS_GHCR_TOKEN     token SEPARADO só com read:packages, para o GHCR. Vazio = imagens públicas.
#   CS_GH_USER, CS_REPO_URL, CS_DIR.
# Os tokens nunca vão para argv, URL, log ou histórico: o git lê o token por GIT_ASKPASS (variável de ambiente).
set -euo pipefail
umask 077

die() { printf 'ERRO: %s\n' "$*" >&2; exit 1; }
info() { printf '==> %s\n' "$*"; }

REPO_URL="${CS_REPO_URL:-https://github.com/felip2ee/credit-system.git}"
REF="${CS_REF:-}"
DIR="${CS_DIR:-/opt/credit-system}"
EXPECTED_SHA="${CS_EXPECTED_SHA:-}"
ASKPASS_DIR=""
UPDATE=0
CHECK_ONLY=0 # --check-ref: só valida os argumentos e sai (usado pelos testes)

for arg in "$@"; do
  case "$arg" in
    --dry-run | --yes | --confirm-backup | --update-only) ;;
    --update) UPDATE=1; [ -n "$REF" ] || REF="latest-main" ;;
    --check-ref) CHECK_ONLY=1 ;;
    *) die "opção desconhecida: $arg (use --dry-run, --yes, --confirm-backup, --update-only, --update)" ;;
  esac
done

SHA_RE='^[0-9a-f]{40}$'
TAG_RE='^refs/tags/[A-Za-z0-9][A-Za-z0-9._-]*$'
[ -n "$REF" ] || die "defina CS_REF com um SHA completo ou refs/tags/<tag> (ex.: export CS_REF=refs/tags/v1.0.0). O padrão 'main' é proibido."
if [ "$REF" = "latest-main" ]; then
  [ "$UPDATE" = 1 ] || die "CS_REF=latest-main só vale com --update. Use um SHA completo ou refs/tags/<tag>."
elif [[ "$REF" =~ $SHA_RE ]]; then :
elif [[ "$REF" =~ $TAG_RE && "$REF" != *..* ]]; then :
else
  die "CS_REF inválido ('$REF'): use um SHA completo (40 hex minúsculos) ou refs/tags/<tag>. Branches (main, develop, feature/x, refs/heads/*, origin/*, refs/pull/*) são proibidos."
fi
[[ "$REPO_URL" =~ ^https://github\.com/[^/]+/[^/]+\.git$ ]] || die "CS_REPO_URL deve ser https://github.com/<dono>/<repo>.git."
[[ "$DIR" == /* ]] || die "CS_DIR deve ser um caminho absoluto."
[ -z "$EXPECTED_SHA" ] || [[ "$EXPECTED_SHA" =~ ^[0-9a-f]{40}$ ]] || die "CS_EXPECTED_SHA deve ter 40 caracteres hexadecimais."
if [ "$CHECK_ONLY" = 1 ]; then info "ref válido: $REF"; exit 0; fi

cleanup() {
  [ -n "$ASKPASS_DIR" ] && rm -rf "$ASKPASS_DIR"
  return 0
}
trap cleanup EXIT

[ "$(uname -s)" = "Linux" ] || die "só Linux é suportado (este é $(uname -s))."
case "$(uname -m)" in
  x86_64 | amd64 | aarch64 | arm64) ;;
  *) die "arquitetura não suportada: $(uname -m)." ;;
esac

if [ "$(id -u)" -ne 0 ]; then
  command -v sudo >/dev/null 2>&1 || die "rode como root ou instale o sudo."
  info "Reexecutando com sudo."
  exec sudo --preserve-env=CS_GH_TOKEN,CS_GHCR_TOKEN,CS_GH_USER,CS_REPO_URL,CS_REF,CS_EXPECTED_SHA,CS_DIR,CS_BACKUP_OK bash "$0" "$@"
fi

# Lock contra duas execuções ao mesmo tempo (o fd 9 segue aberto no exec do install.py, que então não trava de novo).
if command -v flock >/dev/null 2>&1; then
  exec 9>/var/lock/credit-system-install.lock
  flock -n 9 || die "outra execução do instalador está em andamento (lock /var/lock/credit-system-install.lock). Espere e rode de novo."
  export CS_LOCK_HELD=1
fi

for tool in curl git python3; do
  command -v "$tool" >/dev/null 2>&1 || die "'$tool' não encontrado. Instale (ex.: apt-get install -y $tool) e rode de novo."
done

if [ -z "${CS_GH_TOKEN:-}" ]; then
  [ -r /dev/tty ] || die "sem terminal para pedir o token. Defina CS_GH_TOKEN no ambiente."
  printf 'Token do GitHub só leitura (contents:read) para baixar o código; digitação oculta: ' >/dev/tty
  IFS= read -rs CS_GH_TOKEN </dev/tty
  printf '\n' >/dev/tty
fi
[ -n "$CS_GH_TOKEN" ] || die "token vazio."
if [ -z "${CS_GHCR_TOKEN+x}" ] && [ -r /dev/tty ]; then
  printf 'Token SEPARADO só com read:packages para o GHCR (vazio = imagens públicas); digitação oculta: ' >/dev/tty
  IFS= read -rs CS_GHCR_TOKEN </dev/tty
  printf '\n' >/dev/tty
fi
if [ -z "${CS_GH_USER:-}" ]; then
  [ -r /dev/tty ] || die "sem terminal para pedir o usuário. Defina CS_GH_USER no ambiente."
  printf 'Usuário do GitHub: ' >/dev/tty
  IFS= read -r CS_GH_USER </dev/tty
fi
[ -n "$CS_GH_USER" ] || die "usuário vazio."
export CS_GH_TOKEN CS_GH_USER
export CS_GHCR_TOKEN="${CS_GHCR_TOKEN:-}"

# GIT_ASKPASS lê o token do ambiente: ele não aparece em argv, na URL do remote nem em .git/config.
# Só responde quando o prompt cita github.com; qualquer outro host recebe falha.
ASKPASS_DIR="$(mktemp -d)"
chmod 700 "$ASKPASS_DIR"
cat >"$ASKPASS_DIR/askpass.sh" <<'ASKPASS'
#!/bin/sh
case "$1" in
  Username*github.com*) printf '%s\n' "x-access-token" ;;
  Password*github.com*) printf '%s\n' "$CS_GH_TOKEN" ;;
  *) exit 1 ;;
esac
ASKPASS
chmod 700 "$ASKPASS_DIR/askpass.sh"
export GIT_ASKPASS="$ASKPASS_DIR/askpass.sh" GIT_TERMINAL_PROMPT=0

if [ "$REF" = "latest-main" ]; then
  # Só o git ls-remote (mesmo token contents:read): sem API, sem escopo extra. Não prova que o build terminou:
  # quem prova é o install.py, que recusa instalar se a imagem desse commit não existir no GHCR.
  remote_main="$(git ls-remote "$REPO_URL" refs/heads/main)" || die "git ls-remote falhou (rede ou token contents:read)."
  REF="$(printf '%s\n' "$remote_main" | head -n1 | cut -f1)"
  [[ "$REF" =~ $SHA_RE ]] || die "não consegui resolver o commit da main (confira o token contents:read)."
  info "latest-main = $REF"
fi

[ -d "$DIR/.git" ] || { mkdir -p "$DIR" && git init --quiet "$DIR"; }
info "Baixando $REF para $DIR."
git -C "$DIR" fetch --quiet "$REPO_URL" "$REF" # SHA completo ou refs/tags/<nome>: sempre explícito
git -C "$DIR" checkout --quiet --detach FETCH_HEAD

HEAD_SHA="$(git -C "$DIR" rev-parse HEAD)"
info "Commit baixado: $HEAD_SHA"
if [ -n "$EXPECTED_SHA" ] && [ "$HEAD_SHA" != "$EXPECTED_SHA" ]; then
  die "o commit baixado ($HEAD_SHA) difere de CS_EXPECTED_SHA ($EXPECTED_SHA). Nada foi executado."
fi

# O token do clone não é mais necessário: só o token do GHCR segue para o install.py.
unset GIT_ASKPASS GIT_TERMINAL_PROMPT CS_GH_TOKEN
cleanup # exec abaixo não dispara o trap EXIT
ASKPASS_DIR=""
cd "$DIR"
exec python3 "$DIR/scripts/setup/install.py" "$@"
