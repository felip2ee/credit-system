"""Variáveis ASAAS_* no .env.production: entram vazias quando ausentes, nunca são sobrescritas e nunca são impressas."""
from __future__ import annotations

import json
import re

import install_detect as det

ASAAS_VARS = ("ASAAS_DRIVER", "ASAAS_API_BASE_URL", "ASAAS_API_KEY", "ASAAS_WEBHOOK_TOKEN")
SECRET_VARS = ("ASAAS_API_KEY", "ASAAS_WEBHOOK_TOKEN")  # valores nunca aparecem na saída
MIN_TOKEN = 32  # mesmo mínimo de readAsaasConfig (src/lib/config.ts)
PLACEHOLDER_TOKEN = "local-webhook-token-0123456789abcdef"  # valor do .env.example
VALIDATORS = {
    "ASAAS_DRIVER": lambda v: v in ("", "asaas"),
    "ASAAS_API_BASE_URL": lambda v: v == "" or v.startswith("https://"),
    "ASAAS_API_KEY": lambda v: True,
    "ASAAS_WEBHOOK_TOKEN": lambda v: v == "" or len(v) >= MIN_TOKEN,
}
DEFAULT_URL = "https://api.asaas.com"  # padrão da stack: ${ASAAS_API_BASE_URL:-https://api.asaas.com}
OFF_LINE = ("  - Asaas: DESLIGADO (preencha ASAAS_DRIVER, ASAAS_API_KEY e ASAAS_WEBHOOK_TOKEN no .env.production)")


def missing_keys(text: str) -> list[str]:
    """Chaves sem linha no arquivo. Linha ilegível (aspas abertas) conta como presente: nunca é reescrita."""
    raw = set(re.findall(r"^[ \t]*(?:export[ \t]+)?([A-Za-z_][A-Za-z0-9_]*)[ \t]*=", text, re.MULTILINE))
    return [k for k in ASAAS_VARS if k not in raw]


def secret_values(text: str) -> set[str]:
    """Valores preenchidos das chaves secretas, para a redação do log."""
    current = det.parse_env(text)
    return {current[k] for k in SECRET_VARS if current.get(k)}


def status_lines(text: str, added: list[str]) -> list[str]:
    """Linhas do resumo. Só nomes de variáveis: nenhum valor, nem de chave, nem de token."""
    current = det.parse_env(text)
    lines = []
    if added:
        lines.append(f"  - {', '.join(added)}: serão adicionadas vazias ao .env.production (valores preenchidos nunca mudam)")
    driver = current.get("ASAAS_DRIVER", "")
    if not driver:
        return lines + [OFF_LINE]
    if driver != "asaas":
        return lines + ["  - AVISO: ASAAS_DRIVER tem valor inválido (use vazio ou 'asaas'); em produção o app recusa."]
    problems = []
    if not current.get("ASAAS_API_KEY"):
        problems.append("ASAAS_API_KEY vazia")
    token = current.get("ASAAS_WEBHOOK_TOKEN", "")
    if not token:
        problems.append("ASAAS_WEBHOOK_TOKEN vazio")
    elif len(token) < MIN_TOKEN:
        problems.append(f"ASAAS_WEBHOOK_TOKEN com menos de {MIN_TOKEN} caracteres")
    elif token == PLACEHOLDER_TOKEN:
        problems.append("ASAAS_WEBHOOK_TOKEN é o valor de exemplo do .env.example")
    url = current.get("ASAAS_API_BASE_URL", "")
    if url and not VALIDATORS["ASAAS_API_BASE_URL"](url):
        problems.append("ASAAS_API_BASE_URL não é https")
    if problems:
        return lines + ["  - AVISO: Asaas LIGADO, mas " + "; ".join(problems) + ". Pix, cartão e webhook vão falhar "
                        "(gere o token com 'openssl rand -hex 24')."]
    return lines + ["  - Asaas: LIGADO (driver asaas; chave e token preenchidos)"]


def running_values(run, service: str) -> dict[str, str] | None:
    """ASAAS_* do serviço no ar (`docker service inspect`). None = não consegui ler. Chamador: nunca imprimir os valores."""
    code, out = run(["docker", "service", "inspect", service, "--format", "{{json .Spec.TaskTemplate.ContainerSpec.Env}}"])
    if code != 0:
        return None
    try:
        items = json.loads(out) or []
    except ValueError:
        return None
    if not isinstance(items, list):
        return None
    pairs = (i.partition("=") for i in items if isinstance(i, str))
    return {k: v for k, _, v in pairs if k in ASAAS_VARS}


def blanked(env: dict[str, str], running: dict[str, str]) -> list[str]:
    """Chaves preenchidas no ar que o deploy deixaria vazias (URL vazia vale o padrão da stack)."""
    return [k for k in ASAAS_VARS if running.get(k) and not env.get(k)
            and not (k == "ASAAS_API_BASE_URL" and running[k] == DEFAULT_URL)]
