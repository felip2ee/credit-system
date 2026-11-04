"""Apoio dos testes do instalador: runner falso com nomes reais do Swarm, servidor simulado, helpers."""
import json
from pathlib import Path

import install as ins
import setup_production as sp

NEW = "a" * 64
OLD = "b" * 64
TOKEN = "ghp_SUPERSECRETTOKEN123456"
CLONE_TOKEN = "github_pat_CLONEONLYTOKEN987654"
APP = "reino_reino_app"  # chave `reino_app` do docker-stack.yml + prefixo da stack `reino`
LISTEN_NGINX = 'LISTEN 0 511 0.0.0.0:80 0.0.0.0:* users:(("nginx",pid=1,fd=6))\n'
LISTEN_DOCKER = 'LISTEN 0 4096 *:443 *:* users:(("docker-proxy",pid=2,fd=4))\n'
LISTEN_NO_USERS = "LISTEN 0 4096 [::]:80 [::]:*\n"
TRAEFIK_ARGS = ["--providers.swarm=true", "--providers.swarm.network=RainhaNet",
                "--entrypoints.websecure.address=:443", "--certificatesresolvers.le.acme.email=a@b.c"]
TRAEFIK_SPEC = json.dumps({"ContainerSpec": {"Args": TRAEFIK_ARGS}, "Networks": [{"Target": "net1"}]})
STACK_SERVICES = "\n".join(f"reino_{k}" for k in ("reino_app", "migrate", "backup", "notifications_cron", "postgres"))
READ_ONLY = {("docker", "version"), ("docker", "info"), ("docker", "stack", "ls"), ("docker", "stack", "services"),
             ("docker", "secret", "ls"), ("docker", "secret", "inspect"), ("docker", "service", "ls"),
             ("docker", "service", "inspect"), ("docker", "network", "inspect"), ("docker", "volume", "ls"),
             ("docker", "ps"), ("ss",), ("git",), ("curl",), ("docker", "buildx")}


class Fake:
    """Runner de teste: `script(args)` devolve (code, out) ou None (-> (0, ''))."""

    def __init__(self, script=None):
        self.script = script or (lambda args: None)
        self.calls = []

    def __call__(self, args, input=None, env=None, cwd=None):
        self.calls.append((list(args), input, env))
        return self.script(list(args)) or (0, "")

    def ran(self, *prefix):
        return [c for c in self.calls if c[0][:len(prefix)] == list(prefix)]

    def mutations(self):
        return [c[0] for c in self.calls if not any(c[0][:len(p)] == list(p) for p in READ_ONLY)]


def server(stack=True, secrets=None, listen="", traefik=True, tasks_state="Running 5 seconds ago",
           migrate="Complete 2 seconds ago", current=OLD, update="completed", volumes="", spec=TRAEFIK_SPEC,
           net_scope="swarm overlay", fail=None, buildx=True):
    secrets = sp.SECRET_NAMES if secrets is None else secrets
    fail = fail or (lambda a: False)

    def script(a):
        if fail(a):
            return 1, "erro simulado"
        if a[:2] == ["docker", "version"]:
            return 0, "27.0"
        if a[:2] == ["docker", "info"]:
            return 0, "active|true"
        if a[:3] == ["docker", "stack", "ls"]:
            return 0, "reino\n" if stack else ""
        if a[:3] == ["docker", "stack", "services"]:
            return 0, STACK_SERVICES
        if a[:3] == ["docker", "volume", "ls"]:
            return 0, volumes
        if a[:3] == ["docker", "secret", "ls"]:
            return 0, "\n".join(secrets)
        if a[:3] == ["docker", "secret", "inspect"]:
            return (0 if a[3] in secrets else 1), ""
        if a[:3] == ["docker", "service", "ls"] and "{{.Name}}\t{{.Image}}" in a:
            return 0, "traefik_traefik\ttraefik:v3.1\n" if traefik else ""
        if a[:3] == ["docker", "service", "inspect"] and "{{json .Spec.TaskTemplate}}" in a:
            return 0, spec
        if a[:3] == ["docker", "network", "inspect"]:
            return 0, net_scope if "{{.Scope}} {{.Driver}}" in a else "RainhaNet"
        if a[:3] == ["docker", "service", "inspect"] and "UpdateStatus" in a[-1]:
            return 0, update
        if a[:3] == ["docker", "service", "inspect"]:
            return 0, f"ghcr.io/felip2ee/reino-credito@sha256:{current}"
        if a[:3] == ["docker", "service", "ps"]:
            state = migrate if a[3] == "reino_migrate" else tasks_state
            return 0, f"{state}\tghcr.io/felip2ee/reino-credito@sha256:{NEW}\n"
        if a[:3] == ["docker", "service", "ls"]:
            return 0, f"{APP}\t1/1\n"
        if a[:3] == ["docker", "service", "logs"]:
            return 0, f"boom password={TOKEN} postgresql://u:hunter2pw@postgres/db\n"
        if a[:4] == ["docker", "buildx", "imagetools", "inspect"]:
            return (0, f"Name: x\nDigest:    sha256:{NEW}\n") if buildx else (1, "unauthorized")
        if a[0] == "ss":
            return 0, listen
        if a[0] == "git":
            return 0, "c0ffee\n"
        if a[0] == "curl":
            return 0, "203.0.113.9\n"
        return None
    return Fake(script)


def env_values(**extra):
    base = {k: "" for k in sp.ENV_KEYS} | {"APP_DOMAIN": "app.exemplo.com.br", "REINO_IMAGE_OWNER": "felip2ee",
                                           "REINO_IMAGE_DIGEST": OLD, "REINO_BACKUP_DIGEST": OLD}
    return base | extra


def make_root(tmp, with_env=True):
    root = Path(tmp)
    (root / "docker-stack.yml").write_text("services: {}\n")
    if with_env:
        (root / ".env.production").write_text(sp.render_env(env_values()) + "LGPD_PURGE_ENABLED=1\n")
    return root


def installer(root, run, **kw):
    out = []
    kw.setdefault("yes", True)
    kw.setdefault("environ", {"CS_GHCR_TOKEN": TOKEN, "CS_GH_USER": "felip2ee", "CS_GH_TOKEN": CLONE_TOKEN})
    kw.setdefault("http", lambda url, t: 200)
    kw.setdefault("tls", lambda host: (True, "certificado válido"))
    kw.setdefault("timeouts", {"migrate": 1, "app": 1, "http": 1})
    kw.setdefault("secure_dir", Path(root) / "secure")
    kw.setdefault("stamp", lambda: "T1")
    return ins.Installer(run=run, root=root, out=out.append, sleep=lambda s: None, **kw), out


def fake_clock():
    t = [0.0]

    def clock():
        t[0] += 1.0
        return t[0]
    return clock
