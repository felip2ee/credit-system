"""Detecção do que já existe no servidor (somente leitura). Funções puras + Runner injetável."""
from __future__ import annotations

import json
import re
import shlex
import socket
from dataclasses import dataclass, field
from typing import Callable

import install_traefik as tfk
import setup_production as sp

Runner = sp.Runner
STACK = "reino"
WEB_PORTS = (80, 443)
SERVICE_KEYS = ("reino_app", "migrate", "backup", "notifications_cron")
DOCKER_PROCS = ("docker-proxy", "dockerd")
# Segredos que dependem uns dos outros (senha de role -> DSN). Não podem ser recriados pela metade.
DB_SECRETS = frozenset({
    "postgres_password", "schema_owner_password", "app_runtime_password", "backup_reader_password",
    "app_webhook_password", "app_dispatch_password", "database_url", "database_webhook_url",
    "dispatch_database_url", "database_owner_url",
})


@dataclass
class TraefikInfo:
    name: str
    network: str = ""
    resolver: str = ""
    ambiguous: list[str] = field(default_factory=list)  # escolhas que o --yes não pode fazer sozinho
    warnings: list[str] = field(default_factory=list)


@dataclass
class PortListener:
    port: int
    process: str


@dataclass
class Preflight:
    docker: bool = False
    swarm_active: bool = False
    swarm_manager: bool = False
    traefik: TraefikInfo | None = None
    stack_exists: bool = False
    existing_secrets: set[str] = field(default_factory=set)
    port_conflicts: list[PortListener] = field(default_factory=list)
    ss_failed: bool = False
    host_postgres: bool = False
    postgres_volumes: list[str] = field(default_factory=list)


def parse_listeners(ss_output: str) -> list[PortListener]:
    """Lê `ss -H -tlnp` e devolve quem escuta nas portas 80 e 443."""
    found: list[PortListener] = []
    for line in ss_output.splitlines():
        cols = line.split()
        if len(cols) < 4:
            continue
        match = re.search(r":(\d+)$", cols[3])
        if not match or int(match.group(1)) not in WEB_PORTS:
            continue
        proc = re.search(r'users:\(\("([^"]+)"', line)
        found.append(PortListener(int(match.group(1)), proc.group(1) if proc else "desconhecido"))
    return found


def find_port_conflicts(listeners: list[PortListener], traefik: TraefikInfo | None) -> list[PortListener]:
    """Conflito = processo do host que não é o Docker. Se não há Traefik, o Docker também conflita."""
    return [l for l in listeners if l.process not in DOCKER_PROCS or traefik is None]


SYSTEM_NETWORKS = ("ingress", "bridge", "host", "docker_gwbridge")
TRAEFIK_IMAGE = re.compile(r"^(.*/)?traefik(:|@|$)", re.IGNORECASE)


def parse_traefik(name: str, args: list[str], networks: list[str]) -> TraefikInfo:
    """`args` = comando do Traefik; `networks` = nomes das redes em que ele está."""
    info = TraefikInfo(name=name)
    explicit = ""
    for arg in args:
        match = re.search(r"--providers\.(?:docker|swarm)\.network=(\S+)", arg)
        if match:
            explicit = match.group(1)
            break
    candidates = [n for n in networks if n not in SYSTEM_NETWORKS]
    info.network = explicit or (candidates[0] if candidates else "")
    if not explicit and len(candidates) > 1:
        info.ambiguous.append("redes candidatas do Traefik: " + ", ".join(candidates))
    resolvers = list(dict.fromkeys(m for a in args for m in re.findall(r"--certificatesresolvers\.([A-Za-z0-9_-]+)\.", a)))
    info.resolver = resolvers[0] if resolvers else ""
    if len(resolvers) > 1:
        info.ambiguous.append("certresolvers do Traefik: " + ", ".join(resolvers))
    return info


def finish_traefik(info: TraefikInfo, args: list[str], run: Runner) -> TraefikInfo:
    """Valida rede (overlay de escopo swarm) e avisa sobre provider/entrypoint não evidentes."""
    if info.network and not tfk.valid_name(info.network):
        info.warnings.append("o nome da rede do Traefik tem caracteres inválidos; ignorei.")
        info.network = ""
    elif info.network:
        code, out = run(["docker", "network", "inspect", info.network, "--format", "{{.Scope}} {{.Driver}}"])
        if code != 0 or out.strip() != "swarm overlay":
            info.warnings.append(f"a rede '{info.network}' não é overlay de escopo swarm "
                                 f"({out.strip() or 'não encontrada'}); não vou usá-la como padrão.")
            info.network = ""
    joined = " ".join(args)
    if "--providers.swarm" not in joined and not ("--providers.docker" in joined and "swarmMode" in joined):
        info.warnings.append("não vi o provider swarm nos argumentos do Traefik (pode vir de arquivo de configuração).")
    if "entrypoints.websecure" not in joined.lower():
        info.warnings.append("não vi o entrypoint 'websecure' nos argumentos do Traefik; o docker-stack.yml usa esse nome.")
    return info


def _json(text: str):
    try:
        return json.loads(text)
    except ValueError:
        return None


def _network_names(ids: list[str], run: Runner) -> list[str]:
    names = []
    for ident in ids:
        code, out = run(["docker", "network", "inspect", ident, "--format", "{{.Name}}"])
        if code == 0 and out.strip():
            names.append(out.strip())
    return names


def detect_traefik(run: Runner) -> TraefikInfo | None:
    code, out = run(["docker", "service", "ls", "--format", "{{.Name}}\t{{.Image}}"])
    for line in out.splitlines() if code == 0 else []:
        name, _, image = line.partition("\t")
        if not TRAEFIK_IMAGE.match(image.strip()):
            continue
        code, raw = run(["docker", "service", "inspect", name, "--format", "{{json .Spec.TaskTemplate}}"])
        spec = _json(raw) if code == 0 else None
        if not isinstance(spec, dict):
            return TraefikInfo(name=name)
        container = spec.get("ContainerSpec") or {}
        args = list(container.get("Args") or []) + list(container.get("Command") or [])
        ids = [n.get("Target", "") for n in spec.get("Networks") or []]
        return finish_traefik(parse_traefik(name, args, _network_names(ids, run)), args, run)
    code, out = run(["docker", "ps", "--format", "{{.ID}}\t{{.Image}}\t{{.Names}}"])
    for line in out.splitlines() if code == 0 else []:
        ident, _, rest = line.partition("\t")
        image, _, name = rest.partition("\t")
        if not TRAEFIK_IMAGE.match(image.strip()):
            continue
        code, raw = run(["docker", "inspect", ident, "--format", "{{json .}}"])
        data = _json(raw) if code == 0 else None
        if not isinstance(data, dict):
            return TraefikInfo(name=name)
        args = list((data.get("Args") or [])) + list((data.get("Config") or {}).get("Cmd") or [])
        nets = list(((data.get("NetworkSettings") or {}).get("Networks") or {}).keys())
        return finish_traefik(parse_traefik(name, args, nets), args, run)
    return None


def detect(run: Runner) -> Preflight:
    pre = Preflight()
    code, _ = run(["docker", "version", "--format", "{{.Server.Version}}"])
    pre.docker = code == 0
    if pre.docker:
        _, state = run(["docker", "info", "--format", "{{.Swarm.LocalNodeState}}|{{.Swarm.ControlAvailable}}"])
        local, _, control = state.strip().partition("|")
        pre.swarm_active = local == "active"
        pre.swarm_manager = pre.swarm_active and control == "true"
    if pre.swarm_manager:
        pre.traefik = detect_traefik(run)
        _, stacks = run(["docker", "stack", "ls", "--format", "{{.Name}}"])
        pre.stack_exists = STACK in stacks.split()
        _, names = run(["docker", "secret", "ls", "--format", "{{.Name}}"])
        pre.existing_secrets = {n for n in names.split() if n in sp.SECRET_NAMES}
    elif pre.docker:
        pre.traefik = detect_traefik(run)
    code, out = run(["ss", "-H", "-tlnp"])
    pre.ss_failed = code != 0
    listeners = parse_listeners(out) if code == 0 else []
    if pre.docker:
        _, vols = run(["docker", "volume", "ls", "--format", "{{.Name}}"])
        pre.postgres_volumes = [v for v in vols.split() if v.endswith("_postgres_data")]
    pre.port_conflicts = find_port_conflicts(listeners, pre.traefik)
    pre.host_postgres = any(re.search(r":5432\s", line) and "postgres" in line for line in out.splitlines())
    return pre


def service_names(stack: str, run: Runner) -> dict[str, str]:
    """Nome real de cada serviço do compose (`<stack>_<chave>`), descoberto no Swarm; com fallback."""
    code, out = run(["docker", "stack", "services", stack, "--format", "{{.Name}}"])
    live = out.split() if code == 0 else []
    return {key: next((n for n in live if n.endswith(f"_{key}")), f"{stack}_{key}") for key in SERVICE_KEYS}


def missing_secrets(existing: set[str]) -> list[str]:
    return [n for n in sp.SECRET_NAMES if n not in existing]


def partial_db_secrets(existing: set[str]) -> bool:
    """True se parte dos segredos do banco existe e parte não: recriar quebraria a senha do Postgres."""
    have = DB_SECRETS & existing
    return bool(have) and have != DB_SECRETS


def parse_env(text: str) -> dict[str, str]:
    values: dict[str, str] = {}
    for line in text.splitlines():
        if not line.strip() or line.lstrip().startswith("#") or "=" not in line:
            continue
        key, _, raw = line.partition("=")
        try:
            parts = shlex.split(raw)
        except ValueError:
            continue
        values[key.strip()] = parts[0] if parts else ""
    return values


def set_env_value(text: str, key: str, value: str) -> str:
    """Troca (ou acrescenta) uma linha KEY=... sem tocar no resto do arquivo."""
    line = f"{key}={value}"
    eol = "\r\n" if "\r\n" in text else "\n"  # preserva CRLF
    pattern = re.compile(rf"^{re.escape(key)}=[^\r\n]*", re.MULTILINE)
    if pattern.search(text):
        return pattern.sub(lambda _m: line, text)
    return text.rstrip("\r\n") + eol + line + eol


_DIGEST_LINE = re.compile(r"Digest:\s+sha256:([0-9a-f]{64})")
_REPO_DIGEST = re.compile(r"@sha256:([0-9a-f]{64})")


def parse_digest(text: str) -> str | None:
    match = _DIGEST_LINE.search(text) or _REPO_DIGEST.search(text)
    return match.group(1) if match else None


def resolve_digest(ref: str, run: Runner, allow_pull: bool = True) -> str | None:
    """Digest do índice de `ref` (ghcr.io/<dono>/<imagem>:<tag>). buildx primeiro, depois pull."""
    code, out = run(["docker", "buildx", "imagetools", "inspect", ref])
    if code == 0 and (digest := parse_digest(out)):
        return digest
    if not allow_pull:
        return None
    code, _ = run(["docker", "pull", "-q", ref])
    if code != 0:
        return None
    code, out = run(["docker", "image", "inspect", ref, "--format", "{{index .RepoDigests 0}}"])
    return parse_digest(out) if code == 0 else None


def dns_check(domain: str, public_ip: str | None,
              resolver: Callable[[str], list[str]] = lambda d: socket.gethostbyname_ex(d)[2]) -> tuple[bool, str]:
    try:
        addrs = resolver(domain)
    except OSError:
        return False, f"{domain} não resolve no DNS."
    if public_ip is None:
        return False, f"{domain} -> {', '.join(addrs)}; não consegui descobrir o IP público deste servidor."
    if public_ip in addrs:
        return True, f"{domain} -> {public_ip} (ok)."
    return False, f"{domain} -> {', '.join(addrs)}, mas este servidor é {public_ip}."


def public_ip(run: Runner) -> str | None:
    for url in ("https://api.ipify.org", "https://ifconfig.me/ip"):
        code, out = run(["curl", "-fsS", "--max-time", "8", url])
        if code == 0 and re.fullmatch(r"[0-9a-fA-F:.]{3,45}", out.strip()):
            return out.strip()
    return None
