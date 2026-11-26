"""Coleta de configuração do instalador: pergunta só o que não dá para gerar ou detectar."""
from __future__ import annotations

import secrets
import base64

import install_asaas as asaas
import setup_production as sp

PLAN = "Vou perguntar: domínio, SMTP, superadmin, DEPS, OpenAI, backup S3; WhatsApp e push são opcionais."
S3_NOTE = "O backup externo (S3) é obrigatório na stack (docker-stack.yml exige endpoint e bucket): preciso dos 4 valores."
DEFAULT_OWNER = "felip2ee"
AUTO_ENV = {"REINO_IMAGE_OWNER", "REINO_IMAGE_DIGEST", "REINO_BACKUP_DIGEST", "WHATSAPP_DRIVER",
            "WHATSAPP_PHONE_NUMBER_ID", "WHATSAPP_GRAPH_VERSION", "WEB_PUSH_VAPID_PUBLIC_KEY",
            "WEB_PUSH_VAPID_SUBJECT"}
AUTO_SECRETS = {"superadmin_password", "whatsapp_access_token", "whatsapp_app_secret", "web_push_vapid_private_key"}


def _b64(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).decode().rstrip("=")


def _tlv(der: bytes, pos: int) -> tuple[int, bytes, int]:
    """(tag, valor, próxima posição) de um item DER."""
    tag, size, pos = der[pos], der[pos + 1], pos + 2
    if size & 0x80:
        count = size & 0x7F
        size, pos = int.from_bytes(der[pos:pos + count], "big"), pos + count
    return tag, der[pos:pos + size], pos + size


def parse_ec_pem(pem: str) -> tuple[str, str] | None:
    """(pública 87, privada 43) em base64url de uma chave EC SEC1 (P-256), ou None."""
    try:
        der = base64.b64decode("".join(l for l in pem.splitlines() if l and not l.startswith("-----")))
        _, body, _ = _tlv(der, 0)
        _, _, pos = _tlv(body, 0)
        _, priv, pos = _tlv(body, pos)
        pub = b""
        while pos < len(body):
            tag, value, pos = _tlv(body, pos)
            if tag == 0xA1:
                pub = _tlv(value, 0)[1][1:]  # BIT STRING: tira o byte de bits livres
    except (ValueError, IndexError):
        return None
    pair = (_b64(pub), _b64(priv))
    ok = len(pub) == 65 and pub[0] == 4 and len(priv) == 32
    return pair if ok and sp.valid_vapid_public(pair[0]) and sp.valid_vapid_private(pair[1]) else None


def generate_vapid(run) -> tuple[str, str] | None:
    """Gera o par VAPID com o `openssl` do servidor (sem dependências). PEM e não DER: o runner devolve texto."""
    code, out = run(["openssl", "ecparam", "-name", "prime256v1", "-genkey", "-noout"])
    return parse_ec_pem(out) if code == 0 else None


def yes_no(core, question: str, default_yes: bool) -> bool:
    answer = core.input_fn(f"{question} [{'S/n' if default_yes else 's/N'}]: ").strip().lower()
    return default_yes if not answer else answer in ("s", "sim", "y", "yes")


def collect_installer(core, defaults: dict[str, str]) -> tuple[dict[str, str], dict[str, str]]:
    core.say(PLAN)
    whatsapp = yes_no(core, "Ativar WhatsApp (Meta Cloud API)?", False)
    push = yes_no(core, "Ativar notificações push no portal?", True)
    core.say(S3_NOTE)
    env, provided = sp.collect(core.run, core.input_fn, core.getpass_fn,
                               defaults={"REINO_IMAGE_OWNER": DEFAULT_OWNER, **defaults},
                               skip=AUTO_ENV, skip_secrets=AUTO_SECRETS)
    if whatsapp:
        env["WHATSAPP_DRIVER"] = core.ask("Driver do WhatsApp (meta = Cloud API)", "meta", lambda v: v == "meta")
        env["WHATSAPP_PHONE_NUMBER_ID"] = core.ask("ID do número do WhatsApp", "", lambda v: bool(v.strip()))
        env["WHATSAPP_GRAPH_VERSION"] = core.ask("Versão da Graph API da Meta", "v21.0", lambda v: bool(v.strip()))
        provided["whatsapp_access_token"] = sp.ask_secret("Token de sistema do WhatsApp", lambda v: bool(v), core.getpass_fn)
        provided["whatsapp_app_secret"] = sp.ask_secret("App secret da Meta", lambda v: bool(v), core.getpass_fn)
    if push:
        pair = generate_vapid(core.run)
        if pair:
            core.ok("Chaves VAPID do push geradas")
        else:
            core.say("Não consegui gerar as chaves VAPID (o 'openssl' falhou ou não existe). Informe as duas.")
            pub = core.ask("Chave pública VAPID (87 caracteres base64url)", "", lambda v: v != "" and sp.valid_vapid_public(v))
            priv = sp.ask_secret("Chave privada VAPID (43 caracteres base64url)",
                                 lambda v: v != "" and sp.valid_vapid_private(v), core.getpass_fn)
            pair = (pub, priv)
        env["WEB_PUSH_VAPID_PUBLIC_KEY"], provided["web_push_vapid_private_key"] = pair
        env["WEB_PUSH_VAPID_SUBJECT"] = core.ask("Contato VAPID (mailto: ou https://)", f"mailto:{env['SUPERADMIN_EMAIL']}",
                                                 lambda v: v != "" and sp.valid_vapid_subject(v))
    env.update(collect_asaas(core))
    return env, provided


def ask_missing_asaas(core, current: dict[str, str]) -> dict[str, str]:
    """Atualização: se a chave do Asaas está vazia no .env.production, pergunta e devolve os valores a gravar.
    Resposta vazia = pular (nada muda). Chave já preenchida nunca é perguntada nem tocada."""
    if current.get("ASAAS_API_KEY"):
        return {}
    key = core.getpass_fn("Chave de API do Asaas (vazio = pular): ").strip()
    if not key:
        return {}
    values = {"ASAAS_DRIVER": "asaas", "ASAAS_API_KEY": key}
    if not current.get("ASAAS_API_BASE_URL"):
        values["ASAAS_API_BASE_URL"] = asaas.DEFAULT_URL
    token = current.get("ASAAS_WEBHOOK_TOKEN", "")
    if len(token) < asaas.MIN_TOKEN:
        token = secrets.token_hex(24)
        core.say("Token do webhook gerado e gravado em ASAAS_WEBHOOK_TOKEN no .env.production "
                 "(copie de lá para o painel do Asaas; o valor não é impresso).")
        values["ASAAS_WEBHOOK_TOKEN"] = token
    core.secret_values |= {key, token}
    return values


def collect_asaas(core) -> dict[str, str]:
    """Opcional: resposta vazia = Asaas desligado. Chave e token vão para o .env.production e nunca para a saída."""
    values = {k: "" for k in asaas.ASAAS_VARS}
    driver = core.ask("Asaas ligado? Digite asaas (vazio = desligado)", "", asaas.VALIDATORS["ASAAS_DRIVER"])
    if driver != "asaas":
        return values
    values["ASAAS_DRIVER"] = driver
    values["ASAAS_API_BASE_URL"] = core.ask("URL da API do Asaas", asaas.DEFAULT_URL, lambda v: v.startswith("https://"))
    values["ASAAS_API_KEY"] = sp.ask_secret("Chave de API do Asaas", lambda v: bool(v.strip()), core.getpass_fn)
    values["ASAAS_WEBHOOK_TOKEN"] = sp.ask_secret(f"Token do webhook do Asaas (mín. {asaas.MIN_TOKEN} caracteres)",
                                                  lambda v: len(v) >= asaas.MIN_TOKEN, core.getpass_fn)
    core.secret_values |= {values[k] for k in asaas.SECRET_VARS}
    return values
