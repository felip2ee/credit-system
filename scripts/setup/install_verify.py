"""Verificação pós-deploy: espera com timeout, health checks, TLS, logs sem segredos."""
from __future__ import annotations

import http.client
import re
import socket
import ssl
import time
import urllib.parse
from dataclasses import dataclass
from typing import Callable

import setup_production as sp

Runner = sp.Runner
HttpGet = Callable[[str, float], int]
CertCheck = Callable[[str], "tuple[bool, str]"]
TRAEFIK_DEFAULT_CERT = "TRAEFIK DEFAULT CERT"
LOG_LINES = 40
TOTAL_CHECKS = 6
LOCAL_IP = "127.0.0.1"

_URL_PASSWORD = re.compile(r"(\w+://[^:/\s@]+:)[^@\s]+@")
_KV_SECRET = re.compile(r"(?i)((?:pass(?:word)?|secret|token|api[_-]?key)\s*[=:]\s*)\S+")
_JSON_SECRET = re.compile(r'(?i)("(?:pass(?:word|wd)?|secret|(?:access_?|auth_?)?token|api[_-]?key)"\s*:\s*")[^"]*"')
_AUTH_HEADER = re.compile(r"(?i)(authorization\s*[:=]\s*(?:bearer|basic|token)\s+)\S+")


@dataclass
class Check:
    name: str
    ok: bool
    detail: str = ""
    critical: bool = False  # falha que justifica rollback (migração ou convergência do app)


def redact(text: str, secret_values: set[str] | frozenset[str] = frozenset()) -> str:
    for value in sorted((v for v in secret_values if len(v) >= 6), key=len, reverse=True):
        text = text.replace(value, "***")
    text = _AUTH_HEADER.sub(r"\1***", _JSON_SECRET.sub(r'\1***"', text))
    return _KV_SECRET.sub(r"\1***", _URL_PASSWORD.sub(r"\1***@", text))


def wait_until(probe: Callable[[], "tuple[bool, str]"], timeout: float, interval: float,
               sleep: Callable[[float], None] = time.sleep,
               clock: Callable[[], float] = time.monotonic) -> tuple[bool, str]:
    """Repete `probe` até dar ok ou estourar `timeout`. Sempre tenta ao menos uma vez."""
    deadline = clock() + timeout
    detail = ""
    while True:
        ok, detail = probe()
        if ok:
            return True, detail
        if clock() + interval > deadline:
            return False, detail
        sleep(interval)


class _LocalHTTPS(http.client.HTTPSConnection):
    """Conecta em 127.0.0.1:443 mas envia SNI e Host do domínio; a verificação do certificado fica estrita."""

    def connect(self) -> None:
        sock = socket.create_connection((LOCAL_IP, self.port), self.timeout)
        self.sock = self._context.wrap_socket(sock, server_hostname=self.host)


def http_status(url: str, timeout: float) -> int:
    """Status de um GET https sem seguir redirecionamento, direto neste servidor (não depende do DNS)."""
    parts = urllib.parse.urlsplit(url)
    conn = _LocalHTTPS(parts.hostname or "", 443, timeout=timeout, context=ssl.create_default_context())
    try:
        conn.request("GET", parts.path or "/", headers={"User-Agent": "reino-installer"})
        return conn.getresponse().status
    except (OSError, http.client.HTTPException):
        return 0
    finally:
        conn.close()


def tls_check(host: str) -> tuple[bool, str]:
    """Certificado confiável para `host` (SNI) e que não seja o padrão do Traefik, medido em 127.0.0.1."""
    try:
        with socket.create_connection((LOCAL_IP, 443), timeout=8) as sock:
            with ssl.create_default_context().wrap_socket(sock, server_hostname=host) as tls:
                cert = tls.getpeercert() or {}
    except ssl.SSLCertVerificationError as exc:
        return False, f"certificado inválido ({exc.verify_message})"
    except OSError as exc:
        return False, f"sem conexão TLS ({exc})"
    flat = " ".join(v for rdn in (cert.get("subject", ()) + cert.get("issuer", ())) for _, v in rdn)
    if TRAEFIK_DEFAULT_CERT in flat.upper():
        return False, "o Traefik serviu o certificado padrão (Let's Encrypt ainda não emitiu)"
    return True, "certificado válido"


def service_tasks(service: str, run: Runner) -> list[tuple[str, str]]:
    """(estado, imagem) das tarefas, da mais nova para a mais antiga."""
    code, out = run(["docker", "service", "ps", service, "--no-trunc", "--format",
                     "{{.CurrentState}}\t{{.Image}}"])
    if code != 0:
        return []
    return [(s, i) for s, _, i in (line.partition("\t") for line in out.splitlines()) if s]


def migrate_probe(digest: str, run: Runner, service: str) -> Callable[[], "tuple[bool, str]"]:
    def probe() -> tuple[bool, str]:
        tasks = [t for t in service_tasks(service, run) if digest in t[1]]
        if not tasks:
            return False, f"{service} ainda sem tarefa da nova imagem"
        state = tasks[0][0]
        return state.startswith("Complete"), f"{service}: {state}"
    return probe


def update_state(service: str, run: Runner) -> str:
    _, out = run(["docker", "service", "inspect", service, "--format",
                  "{{if .UpdateStatus}}{{.UpdateStatus.State}}{{end}}"])
    return out.strip()


def app_probe(digest: str, run: Runner, service: str) -> Callable[[], "tuple[bool, str]"]:
    def probe() -> tuple[bool, str]:
        if update_state(service, run).startswith("rollback"):
            return False, f"o Swarm iniciou rollback de {service}"
        tasks = [t for t in service_tasks(service, run) if digest in t[1]]
        failed = [s for s, _ in tasks if s.startswith(("Failed", "Rejected"))]
        if len(failed) >= 2:
            return False, f"{service} reiniciando em loop ({len(failed)} falhas)"
        _, replicas = run(["docker", "service", "ls", "--filter", f"name={service}", "--format",
                           "{{.Name}}\t{{.Replicas}}"])
        row = next((l for l in replicas.splitlines() if l.startswith(f"{service}\t")), "")
        count = row.partition("\t")[2].split()[0] if row else ""
        running = bool(tasks) and tasks[0][0].startswith("Running")
        ok = running and count != "" and count.split("/")[0] == count.split("/")[-1] and not failed
        return ok, f"{service}: réplicas {count or '?'}, tarefa {tasks[0][0] if tasks else 'nenhuma'}"
    return probe


def url_probe(url: str, http: HttpGet, want: int = 200) -> Callable[[], "tuple[bool, str]"]:
    def probe() -> tuple[bool, str]:
        status = http(url, 10)
        return status == want, f"GET {url} -> {status or 'sem resposta'}"
    return probe


def run_checks(domain: str, digest: str, run: Runner, http: HttpGet = http_status,
               tls: CertCheck = tls_check, say: Callable[[str], None] = print,
               sleep: Callable[[float], None] = time.sleep,
               clock: Callable[[], float] = time.monotonic,
               names: dict[str, str] | None = None, migrate_timeout: float = 300, app_timeout: float = 420, http_timeout: float = 180) -> list[Check]:
    """Para no primeiro check que falha (os seguintes dependem dele)."""
    base = f"https://{domain}"
    names = names or {"reino_app": "reino_reino_app", "migrate": "reino_migrate"}
    steps: list[tuple[str, Callable[[], "tuple[bool, str]"], float, float, bool]] = [
        (f"migração ({names['migrate']})", migrate_probe(digest, run, names["migrate"]), migrate_timeout, 5, True),
        (f"app ({names['reino_app']})", app_probe(digest, run, names["reino_app"]), app_timeout, 10, True),
        ("health live", url_probe(f"{base}/api/health/live", http), http_timeout, 5, False),
        ("health ready", url_probe(f"{base}/api/health/ready", http), http_timeout, 5, False),
        ("certificado TLS", lambda: tls(domain), http_timeout, 10, False),
        ("página de login", url_probe(f"{base}/login", http), http_timeout, 5, False),
    ]
    results: list[Check] = []
    for name, probe, timeout, interval, critical in steps:
        say(f"... verificando {name} (até {int(timeout)}s)")
        ok, detail = wait_until(probe, timeout, interval, sleep, clock)
        results.append(Check(name, ok, detail, critical))
        say(f"{'✔' if ok else '✘'} {name}: {detail}")
        if not ok:
            break
    return results


def failing_service(checks: list[Check], names: dict[str, str]) -> str:
    last = checks[-1].name if checks else ""
    return names["migrate"] if last.startswith("migração") else names["reino_app"]


def fetch_logs(service: str, run: Runner, secret_values: set[str] | frozenset[str] = frozenset()) -> str:
    _, out = run(["docker", "service", "logs", "--tail", str(LOG_LINES), "--no-task-ids", service])
    return redact(out, secret_values)
