"""Atualização rápida: o que o código novo exige do .env.production e o resumo mostrado antes de aplicar."""
from __future__ import annotations

import re
import shlex
from dataclasses import dataclass, field
from pathlib import Path

import install_detect as det
from install_core import ENV_FILE

# Sem estes valores a instalação não está completa: não dá para atualizar sem perguntar.
REQUIRED_ENV = ("APP_DOMAIN", "REINO_IMAGE_OWNER", "SMTP_HOST", "SUPERADMIN_EMAIL",
                "RESTIC_S3_ENDPOINT", "RESTIC_S3_BUCKET")
# Variáveis que entraram com o PR #89. Valores reais da conta Asaas (docs/operations/payments.md, seção 2).
NEW_VARS = {
    "PIX_FEE_CENTS": "199",
    "CARD_FEE_TABLE": "1:2.99:49,6:2.99:49,12:2.99:49",
    "CARD_MIN_INSTALLMENT_CENTS": "500",
}
_BAND = r"\d{1,2}:\d{1,2}(?:\.\d{1,4})?:\d{1,6}"
_CARD_TABLE = re.compile(rf"{_BAND}(?:,{_BAND})*", re.ASCII)  # fullmatch: `$` aceitaria "\n" no fim
VALIDATORS = {
    "PIX_FEE_CENTS": lambda v: v.isascii() and v.isdigit(),
    "CARD_FEE_TABLE": lambda v: v == "" or bool(_CARD_TABLE.fullmatch(v)),  # vazio = cartão desligado
    "CARD_MIN_INSTALLMENT_CENTS": lambda v: v == "" or (v.isascii() and v.isdigit() and int(v) > 0),
}
PROMPTS = {
    "PIX_FEE_CENTS": "Taxa do Pix repassada ao pagador, em centavos (199 = R$ 1,99; 0 = sem taxa)",
    "CARD_FEE_TABLE": "Tabela de taxas do cartão (parcelas:percentual:centavos, separadas por vírgula; vazio = desligado)",
    "CARD_MIN_INSTALLMENT_CENTS": "Parcela mínima do cartão, em centavos",
}
_SHA = re.compile(r"^[0-9a-f]{40}$")


@dataclass
class EnvPlan:
    added: list[str] = field(default_factory=list)    # chave ausente
    filled: list[str] = field(default_factory=list)   # PIX_FEE_CENTS existia vazia
    invalid: list[str] = field(default_factory=list)  # valor preenchido, mas inválido: nunca trocado sem perguntar


def missing_required(text: str) -> list[str]:
    current = det.parse_env(text)
    return [k for k in REQUIRED_ENV if not current.get(k)]


def plan_env(text: str) -> EnvPlan:
    """Só lê. Variável já preenchida e válida nunca entra no plano."""
    current, plan = det.parse_env(text), EnvPlan()
    raw = set(re.findall(r"^[ \t]*([A-Za-z_][A-Za-z0-9_]*)[ \t]*=", text, re.MULTILINE))
    for key in NEW_VARS:
        if key not in current:
            # linha presente que o parse não leu (aspas abertas...) NÃO é "ausente": nunca sobrescrever sem perguntar
            (plan.invalid if key in raw else plan.added).append(key)
        elif key == "PIX_FEE_CENTS" and current[key] == "":
            plan.filled.append(key)  # vazia: a stack falharia (`${PIX_FEE_CENTS:?}`)
        elif not VALIDATORS[key](current[key]):
            plan.invalid.append(key)
    return plan


def apply_values(text: str, values: dict[str, str]) -> str:
    for key, value in values.items():
        text = det.set_env_value(text, key, shlex.quote(value))
    return text


def migrations_note(run, root: Path, deployed_sha: str) -> tuple[str, bool]:
    """(texto, pode_haver_migration). Pelo diff de arquivos entre o commit em execução e o novo (não lê o banco).
    Versão desconhecida conta como "pode haver": migrations não voltam."""
    names = sorted(p.name for p in (root / "db" / "migrations").glob("*.sql"))
    latest = names[-1] if names else "nenhuma"
    if _SHA.match(deployed_sha):
        code, out = run(["git", "-C", str(root), "diff", "--name-only", deployed_sha, "HEAD", "--", "db/migrations"])
        if code == 0:
            new = sorted(Path(line).name for line in out.splitlines() if line.endswith(".sql"))
            if not new:
                return f"nenhuma migration nova (última: {latest})", False
            return f"{len(new)} migration(s) nova(s), de {new[0]} até {new[-1]}", True
    return (f"não sei qual versão está no ar (primeira atualização por este instalador); o reino_migrate aplica só as "
            f"pendentes. Última migration desta versão: {latest}"), True


def render_summary(*, domain: str, previous: str | None, target: str, secrets: list[str], plan: EnvPlan,
                   migrations: str, values: dict[str, str], card_table: str) -> list[str]:
    lines = [f"Resumo da atualização (stack {det.STACK}, https://{domain}):",
             f"  - app: {('sha256:' + previous[:12]) if previous else 'versão atual desconhecida'} -> commit {target[:12]}",
             "  - secrets a criar: " + (", ".join(secrets) if secrets else "nenhum (todos já existem)")]
    if plan.added or plan.filled or plan.invalid:
        def kv(keys: list[str]) -> str:  # só variáveis de negócio (taxas), nunca segredos
            return ", ".join(f"{k}={values.get(k, '')}" for k in keys)
        parts = [f"adicionar {kv(plan.added)}"] if plan.added else []
        parts += [f"preencher {kv(plan.filled)} (estava vazia)"] if plan.filled else []
        parts += [f"corrigir {kv(plan.invalid)} (valor anterior inválido ou ilegível)"] if plan.invalid else []
        lines.append(f"  - {ENV_FILE}: " + "; ".join(parts) + ". Nenhuma variável preenchida é alterada.")
    else:
        lines.append(f"  - {ENV_FILE}: sem variáveis novas")
    lines.append(f"  - cartão: será LIGADO (CARD_FEE_TABLE={card_table})" if card_table
                 else "  - cartão: DESLIGADO (CARD_FEE_TABLE vazia)")
    lines += [f"  - banco: {migrations}",
              "  - ordem: o reino_migrate roda primeiro; o app novo só sobe com o schema pronto. Se algo falhar, "
              "o instalador refaz o deploy da versão anterior (migrations não voltam)."]
    return lines
