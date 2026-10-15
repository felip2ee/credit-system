#!/usr/bin/env python3
"""Gera a configuração de produção da Plataforma Bureau.

Pergunta o que só você sabe (domínio, Traefik, SMTP, superadmin, DEPS, OpenAI),
gera todas as senhas internas e grava:

  .env.production          valores NÃO secretos, lidos por `docker stack deploy`
  Docker secrets           todas as senhas e chaves (via stdin, nunca argv)
  credenciais-GUARDAR.txt  cópia de tudo para o seu gerenciador de senhas

Uso:  python3 scripts/setup/setup_production.py [--dry-run] [--no-docker] [--force] [--output-dir DIR]
"""
from __future__ import annotations

import argparse
import getpass
import ipaddress
import json
import os
import re
import secrets
import shlex
import subprocess
import sys
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable

ENV_KEYS = [
    "REINO_IMAGE_OWNER", "REINO_IMAGE_DIGEST", "REINO_BACKUP_DIGEST",
    "APP_DOMAIN", "TRAEFIK_NETWORK", "TRAEFIK_CERT_RESOLVER", "TRAEFIK_PROXY_CIDR",
    "SMTP_HOST", "SMTP_PORT", "SMTP_SECURE", "SMTP_USER", "SMTP_FROM",
    "SUPERADMIN_EMAIL",
    "DEPS_API_BASE_URL", "DEPS_API_EMAIL", "DEPS_API_CENTRO_CUSTOS",
    "DEPS_PRODUTO_PF", "DEPS_PRODUTO_PJ",
    "OPENAI_MODEL", "BACKUP_ALERT_TO",
    "WHATSAPP_DRIVER", "WHATSAPP_PHONE_NUMBER_ID", "WHATSAPP_GRAPH_VERSION",
]

SECRET_NAMES = [
    "postgres_password", "schema_owner_password", "app_runtime_password",
    "backup_reader_password", "app_webhook_password", "database_url",
    "database_webhook_url", "database_owner_url",
    "better_auth_secret", "smtp_pass", "deps_api_password", "openai_api_key",
    "restic_password", "superadmin_password",
    "whatsapp_access_token", "whatsapp_app_secret", "whatsapp_verify_token",
    "notifications_dispatch_secret",
]

_DOMAIN = re.compile(r"^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$")
_EMAIL = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")
_DIGEST = re.compile(r"^[0-9a-f]{64}$")

Runner = Callable[..., "tuple[int, str]"]


def valid_domain(v: str) -> bool:
    return bool(_DOMAIN.match(v.strip().lower()))


def valid_email(v: str) -> bool:
    return bool(_EMAIL.match(v.strip()))


def valid_port(v: str) -> bool:
    return v.isdigit() and 1 <= int(v) <= 65535


def valid_cidr(v: str) -> bool:
    if "/" not in v:
        return False
    try:
        ipaddress.ip_network(v, strict=False)
        return True
    except ValueError:
        return False


def valid_digest(v: str) -> bool:
    return v == "" or bool(_DIGEST.match(v))


def valid_superadmin_password(v: str) -> bool:
    return 12 <= len(v) <= 128


def _any(_: str) -> bool:
    return True


def _nonempty(v: str) -> bool:
    return bool(v.strip())


def _bool(v: str) -> bool:
    return v in ("true", "false")


# (key, pergunta, padrão, validador)
QUESTIONS: list[tuple[str, str, str, Callable[[str], bool]]] = [
    ("APP_DOMAIN", "Domínio da aplicação (ex.: app.seudominio.com.br)", "", valid_domain),
    ("TRAEFIK_NETWORK", "Rede externa do Traefik", "RainhaNet", _nonempty),
    ("TRAEFIK_CERT_RESOLVER", "Certresolver do Traefik", "letsencryptresolver", _nonempty),
    ("TRAEFIK_PROXY_CIDR", "CIDR da rede do Traefik (proxies confiáveis)", "", valid_cidr),
    ("SMTP_HOST", "Servidor SMTP", "", _nonempty),
    ("SMTP_PORT", "Porta SMTP (465 SSL, 587 STARTTLS)", "465", valid_port),
    ("SMTP_SECURE", "SMTP com SSL implícito? (true/false)", "true", _bool),
    ("SMTP_USER", "Usuário SMTP", "", _nonempty),
    ("SMTP_FROM", "Remetente (ex.: Plataforma <no-reply@dominio>)", "", _nonempty),
    ("SUPERADMIN_EMAIL", "E-mail do superadmin", "", valid_email),
    ("DEPS_API_BASE_URL", "URL da API DEPS", "https://api-portal.deps.com.br", _nonempty),
    ("DEPS_API_EMAIL", "Usuário DEPS", "", _nonempty),
    ("DEPS_API_CENTRO_CUSTOS", "Centro de custos DEPS (opcional)", "", _any),
    ("DEPS_PRODUTO_PF", "Produto DEPS PF", "Smart PF 002", _nonempty),
    ("DEPS_PRODUTO_PJ", "Produto DEPS PJ", "Smart PJ 010", _nonempty),
    ("OPENAI_MODEL", "Modelo OpenAI", "gpt-4o", _nonempty),
    ("BACKUP_ALERT_TO", "E-mail para alertas de backup", "", valid_email),
    ("WHATSAPP_DRIVER", "Driver do WhatsApp (vazio = desligado; meta = Cloud API)", "", lambda v: v in ("", "meta")),
    ("WHATSAPP_PHONE_NUMBER_ID", "ID do número do WhatsApp (vazio = WhatsApp desligado)", "", _any),
    ("WHATSAPP_GRAPH_VERSION", "Versão da Graph API da Meta", "v21.0", _nonempty),
    ("REINO_IMAGE_OWNER", "Dono das imagens no GHCR", "felip2ee", _nonempty),
    ("REINO_IMAGE_DIGEST", "Digest sha256 da imagem do app (64 hex; vazio = preencher depois)", "", valid_digest),
    ("REINO_BACKUP_DIGEST", "Digest sha256 da imagem de backup (64 hex; vazio = preencher depois)", "", valid_digest),
]

# (secret, pergunta, validador, gera se vazio?)
SECRET_QUESTIONS: list[tuple[str, str, Callable[[str], bool], bool]] = [
    ("smtp_pass", "Senha SMTP", _nonempty, False),
    ("deps_api_password", "Senha DEPS", _nonempty, False),
    ("openai_api_key", "Chave da API OpenAI", _nonempty, False),
    ("superadmin_password", "Senha do superadmin (vazio = gerar)", lambda v: v == "" or valid_superadmin_password(v), True),
    ("whatsapp_access_token", "Token de sistema do WhatsApp (vazio = WhatsApp desligado)", _any, False),
    ("whatsapp_app_secret", "App secret da Meta (vazio = WhatsApp desligado)", _any, False),
]

# Docker secrets não aceitam valor vazio: WhatsApp desligado grava este marcador.
WHATSAPP_OFF_PLACEHOLDER = "whatsapp-disabled"


def gen_hex(nbytes: int = 24) -> str:
    return secrets.token_hex(nbytes)


def gen_password() -> str:
    return secrets.token_urlsafe(18)  # 24 caracteres


def build_secrets(provided: dict[str, str]) -> dict[str, str]:
    pg, owner, app, backup, webhook = gen_hex(), gen_hex(), gen_hex(), gen_hex(), gen_hex()
    return {
        "postgres_password": pg,
        "schema_owner_password": owner,
        "app_runtime_password": app,
        "backup_reader_password": backup,
        "app_webhook_password": webhook,
        "database_url": f"postgresql://app_runtime:{app}@postgres:5432/credit_system",
        "database_webhook_url": f"postgresql://app_webhook:{webhook}@postgres:5432/credit_system",
        "database_owner_url": f"postgresql://postgres:{pg}@postgres:5432/credit_system",
        "better_auth_secret": gen_hex(32),
        "smtp_pass": provided["smtp_pass"],
        "deps_api_password": provided["deps_api_password"],
        "openai_api_key": provided["openai_api_key"],
        "restic_password": gen_hex(32),
        "superadmin_password": provided.get("superadmin_password") or gen_password(),
        "whatsapp_access_token": provided.get("whatsapp_access_token") or WHATSAPP_OFF_PLACEHOLDER,
        "whatsapp_app_secret": provided.get("whatsapp_app_secret") or WHATSAPP_OFF_PLACEHOLDER,
        "whatsapp_verify_token": gen_hex(32),
        "notifications_dispatch_secret": gen_hex(32),
    }


def render_env(values: dict[str, str]) -> str:
    lines = [
        "# Gerado por scripts/setup/setup_production.py — valores NÃO secretos.",
        "# Deploy: set -a; . ./.env.production; set +a; docker stack deploy -c docker-stack.yml reino",
    ]
    lines += [f"{key}={shlex.quote(values.get(key, ''))}" for key in ENV_KEYS]
    return "\n".join(lines) + "\n"


def render_credentials(env_values: dict[str, str], secret_values: dict[str, str]) -> str:
    out = [
        "CREDENCIAIS DA PLATAFORMA — mova para um gerenciador de senhas e APAGUE este arquivo.",
        "Sem restic_password não há restauração de backup.",
        "",
        f"Superadmin: {env_values.get('SUPERADMIN_EMAIL', '')} / {secret_values['superadmin_password']}",
        "",
        "[Docker secrets]",
    ]
    out += [f"{name}={secret_values[name]}" for name in SECRET_NAMES]
    out += ["", "[.env.production]"]
    out += [f"{key}={env_values.get(key, '')}" for key in ENV_KEYS]
    return "\n".join(out) + "\n"


def default_runner(args: list[str], input: str | None = None) -> tuple[int, str]:
    result = subprocess.run(args, input=input, capture_output=True, text=True)
    return result.returncode, result.stdout


def detect_proxy_cidr(network: str, run: Runner = default_runner) -> str | None:
    code, out = run(["docker", "network", "inspect", network, "--format", "{{json .IPAM.Config}}"])
    if code != 0:
        return None
    try:
        for entry in json.loads(out or "[]"):
            subnet = entry.get("Subnet")
            if subnet and valid_cidr(subnet):
                return subnet
    except (ValueError, AttributeError):
        return None
    return None


@dataclass
class SecretReport:
    created: list[str] = field(default_factory=list)
    skipped: list[str] = field(default_factory=list)


def create_docker_secrets(values: dict[str, str], run: Runner = default_runner) -> SecretReport:
    report = SecretReport()
    for name in SECRET_NAMES:
        code, _ = run(["docker", "secret", "inspect", name])
        if code == 0:
            report.skipped.append(name)
            continue
        code, _ = run(["docker", "secret", "create", name, "-"], input=values[name])
        if code != 0:
            raise RuntimeError(f"falha ao criar o secret {name}")
        report.created.append(name)
    return report


def _write_private(path: Path, content: str, force: bool) -> None:
    flags = os.O_WRONLY | os.O_CREAT | (os.O_TRUNC if force else os.O_EXCL)
    fd = os.open(path, flags, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as fh:
        fh.write(content)
    os.chmod(path, 0o600)


def write_outputs(out_dir: Path, env_values: dict[str, str], secret_values: dict[str, str], force: bool) -> None:
    env_path = out_dir / ".env.production"
    cred_path = out_dir / "credenciais-GUARDAR.txt"
    if not force:
        for path in (env_path, cred_path):
            if path.exists():
                raise FileExistsError(f"{path} já existe (use --force para sobrescrever)")
    _write_private(env_path, render_env(env_values), force)
    _write_private(cred_path, render_credentials(env_values, secret_values), force)


def apply(out_dir: Path, env_values: dict[str, str], secret_values: dict[str, str], run: Runner,
          dry_run: bool, no_docker: bool, force: bool) -> None:
    if dry_run:
        print("\n[dry-run] nada foi gravado. Seria criado:")
        print(f"  {out_dir / '.env.production'}")
        print(f"  {out_dir / 'credenciais-GUARDAR.txt'}")
        if not no_docker:
            print("  Docker secrets: " + ", ".join(SECRET_NAMES))
        return
    write_outputs(out_dir, env_values, secret_values, force)
    if not no_docker:
        report = create_docker_secrets(secret_values, run)
        if report.created:
            print("Secrets criados: " + ", ".join(report.created))
        if report.skipped:
            print("AVISO: já existiam e NÃO foram alterados (secrets do Swarm são imutáveis): "
                  + ", ".join(report.skipped))
            print("       Os valores em credenciais-GUARDAR.txt para esses nomes NÃO estão em uso.")


def ask(prompt: str, default: str, validator: Callable[[str], bool],
        input_fn: Callable[[str], str] = input) -> str:
    suffix = f" [{default}]" if default else ""
    while True:
        value = input_fn(f"{prompt}{suffix}: ").strip() or default
        if validator(value):
            return value
        print("  valor inválido, tente de novo.")


def ask_secret(prompt: str, validator: Callable[[str], bool],
               getpass_fn: Callable[[str], str] = getpass.getpass) -> str:
    while True:
        value = getpass_fn(f"{prompt}: ")
        if validator(value):
            return value
        print("  valor inválido, tente de novo.")


def collect(run: Runner, input_fn=input, getpass_fn=getpass.getpass) -> tuple[dict[str, str], dict[str, str]]:
    env_values: dict[str, str] = {}
    for key, prompt, default, validator in QUESTIONS:
        if key == "TRAEFIK_PROXY_CIDR":
            default = detect_proxy_cidr(env_values["TRAEFIK_NETWORK"], run) or ""
        env_values[key] = ask(prompt, default, validator, input_fn)
    provided = {name: ask_secret(prompt, validator, getpass_fn) for name, prompt, validator, _ in SECRET_QUESTIONS}
    return env_values, provided


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--dry-run", action="store_true", help="mostra o que faria, não grava nada")
    parser.add_argument("--no-docker", action="store_true", help="só grava os arquivos, não cria secrets")
    parser.add_argument("--force", action="store_true", help="sobrescreve .env.production e credenciais existentes")
    parser.add_argument("--output-dir", type=Path, default=Path.cwd())
    args = parser.parse_args(argv)

    env_values, provided = collect(default_runner)
    secret_values = build_secrets(provided)
    try:
        apply(args.output_dir, env_values, secret_values, default_runner,
              dry_run=args.dry_run, no_docker=args.no_docker, force=args.force)
    except FileExistsError as exc:
        print(f"ERRO: {exc}", file=sys.stderr)
        return 1

    if not args.dry_run:
        print("\nPróximos passos:")
        print("  1. Mova credenciais-GUARDAR.txt para um gerenciador de senhas e apague-o do servidor.")
        if not env_values["REINO_IMAGE_DIGEST"] or not env_values["REINO_BACKUP_DIGEST"]:
            print("  2. Preencha REINO_IMAGE_DIGEST e REINO_BACKUP_DIGEST em .env.production (resumo do workflow GHCR).")
        print("  3. set -a; . ./.env.production; set +a; docker stack deploy -c docker-stack.yml reino")
    return 0


if __name__ == "__main__":
    sys.exit(main())
