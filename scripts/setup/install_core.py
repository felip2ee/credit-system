"""Base do instalador: runner, estado compartilhado e utilitários de interação."""
from __future__ import annotations

import fcntl
import getpass
import os
import subprocess
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable

import install_detect as det
import install_verify as ver
import setup_production as sp

ROOT = Path(__file__).resolve().parents[2]
SECURE_DIR = Path("/root/credit-system-credentials")  # fora do git: credenciais e stack do Traefik
ENV_FILE = ".env.production"
GHCR = "ghcr.io"
STACK = det.STACK
LOCK_FILE = Path("/var/lock/credit-system-install.lock")
GH_ENV = ("CS_GH_TOKEN", "CS_GHCR_TOKEN", "CS_GH_USER")  # nunca vão para processos filhos


class Stop(Exception):
    """Interrompe a instalação com uma mensagem clara (código de saída 1)."""


def default_runner(args: list[str], input: str | None = None, env: dict[str, str] | None = None,
                   cwd: Path | None = None) -> tuple[int, str]:
    base = os.environ if env is None else env
    clean = {k: v for k, v in base.items() if k not in GH_ENV}
    try:
        result = subprocess.run(args, input=input, capture_output=True, text=True, env=clean, cwd=cwd)
    except FileNotFoundError:
        return 127, f"comando não encontrado: {args[0]}"
    return result.returncode, result.stdout + result.stderr


def acquire_lock(path: Path | None = None) -> int:
    """Lock exclusivo (flock) contra duas execuções ao mesmo tempo. Devolve o fd: o chamador o mantém aberto."""
    fd = os.open(path or LOCK_FILE, os.O_RDWR | os.O_CREAT, 0o600)
    try:
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        os.close(fd)
        raise Stop("Outra execução do instalador está em andamento (lock em "
                   f"{path or LOCK_FILE}). Espere ela terminar e rode de novo.") from None
    return fd


def read_env_text(path: Path) -> str:
    """Lê sem normalizar fim de linha (CRLF fica) nem perder bytes (surrogateescape)."""
    with open(path, encoding="utf-8", errors="surrogateescape", newline="") as fh:
        return fh.read()


def write_env_atomic(path: Path, text: str) -> None:
    """tmp 0600 no mesmo diretório + os.replace: nunca deixa o .env.production pela metade."""
    tmp = path.with_name(f"{path.name}.tmp-{os.getpid()}")
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    try:
        with os.fdopen(fd, "w", encoding="utf-8", errors="surrogateescape", newline="") as fh:
            fh.write(text)
            fh.flush()
            os.fsync(fh.fileno())
        os.chmod(tmp, 0o600)
        os.replace(tmp, path)
    except BaseException:
        tmp.unlink(missing_ok=True)
        raise


def backup_env(path: Path, stamp: str) -> Path:
    """Cópia byte a byte `<arquivo>.bak-<stamp>` (0600, O_EXCL; sufixo -N se já existe). Nunca sobrescreve."""
    data = path.read_bytes()
    for n in range(1, 100):
        target = path.with_name(f"{path.name}.bak-{stamp}" + ("" if n == 1 else f"-{n}"))
        try:
            fd = os.open(target, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        except FileExistsError:
            continue
        with os.fdopen(fd, "wb") as fh:
            fh.write(data)
        os.chmod(target, 0o600)
        return target
    raise Stop(f"Não consegui criar a cópia de {path.name}: há cópias demais com o mesmo carimbo.")


@dataclass
class Core:
    run: det.Runner = default_runner
    root: Path = ROOT
    secure_dir: Path = SECURE_DIR
    yes: bool = False
    dry_run: bool = False
    update_only: bool = False
    update: bool = False  # atualização rápida: reaproveita tudo e só confirma uma vez
    confirm_backup: bool = False  # operador afirma backup recente (libera --yes com migrations)
    input_fn: Callable[[str], str] = input
    getpass_fn: Callable[[str], str] = getpass.getpass
    http: ver.HttpGet = ver.http_status
    tls: ver.CertCheck = ver.tls_check
    sleep: Callable[[float], None] = time.sleep
    clock: Callable[[], float] = time.monotonic
    out: Callable[[str], None] = print
    stamp: Callable[[], str] = lambda: time.strftime("%Y%m%d-%H%M%S")
    environ: dict[str, str] = field(default_factory=lambda: dict(os.environ))
    gh_token: str = field(default="", repr=False)  # token só com read:packages, só para o GHCR
    gh_user: str = ""
    secret_values: set[str] = field(default_factory=set)
    timeouts: dict[str, float] = field(default_factory=dict)
    logged_in: bool = False
    dns_ok: bool = True
    credential_files: list[Path] = field(default_factory=list)
    reconciled: dict[str, str] = field(default_factory=dict)  # variáveis novas gravadas no .env.production
    previous: str | None = None  # digest do app no ar, lido antes de qualquer mudança
    old_credentials: list[Path] = field(default_factory=list)  # credenciais-novos-* de execuções anteriores

    def __post_init__(self) -> None:
        self.gh_token = self.gh_token or self.environ.get("CS_GHCR_TOKEN", "")
        self.gh_user = self.gh_user or self.environ.get("CS_GH_USER", "")
        self.environ = {k: v for k, v in self.environ.items() if k not in GH_ENV}
        if self.gh_token:
            self.secret_values.add(self.gh_token)

    def say(self, msg: str) -> None:
        self.out(ver.redact(msg, self.secret_values))

    def ok(self, msg: str) -> None:
        self.say(f"✔ {msg}")

    def fail(self, msg: str) -> None:
        self.say(f"✘ {msg}")

    def confirm(self, question: str, default_yes: bool = False) -> bool:
        if self.yes:
            self.say(f"{question} [sim: --yes]")
            return True
        answer = self.input_fn(f"{question} [{'S/n' if default_yes else 's/N'}]: ").strip().lower()
        return default_yes if not answer else answer in ("s", "sim", "y", "yes")

    def ask(self, prompt: str, default: str, validator: Callable[[str], bool]) -> str:
        if self.yes and default and validator(default):
            return default
        return sp.ask(prompt, default, validator, self.input_fn)

    def act(self, description: str) -> bool:
        """False no --dry-run: o passo só é descrito."""
        if self.dry_run:
            self.say(f"[dry-run] {description}")
            return False
        self.say(f"==> {description}")
        return True

    def secure_file(self, name: str, content: str, overwrite: bool = False) -> Path:
        """Grava em `secure_dir` (0700) com modo 0600; sem `overwrite`, nunca trunca arquivo existente."""
        self.secure_dir.mkdir(mode=0o700, parents=True, exist_ok=True)
        os.chmod(self.secure_dir, 0o700)
        path = self.secure_dir / name
        sp._write_private(path, content, overwrite)
        return path
