#!/usr/bin/env python3
"""Instalador da Plataforma Bureau: detecta o servidor, configura, faz o deploy e verifica.

Chamado por scripts/setup/install.sh (root). Reaproveita setup_production.py para segredos e .env.
Uso:  python3 scripts/setup/install.py [--dry-run] [--yes] [--confirm-backup] [--update-only] [--update]
Token do GHCR (só read:packages): variável CS_GHCR_TOKEN (nunca argv). Usuário: CS_GH_USER.
As variáveis CS_GH_* saem do ambiente na partida e nunca chegam a processos filhos.
Com --yes, migrations pendentes só rodam com --confirm-backup (ou CS_BACKUP_OK=1): o operador afirma backup recente.
"""
from __future__ import annotations

import argparse
import os
import sys
from pathlib import Path

import install_asaas as asaas
import install_detect as det
import install_update as upd
import install_verify as ver
import setup_production as sp
from install_collect import yes_no
from install_core import (ENV_FILE, GH_ENV, STACK, Stop, acquire_lock, backup_env,  # noqa: F401 (re-export para testes)
                          default_runner, read_env_text, write_env_atomic)
from install_rollback import Rollback


class Installer(Rollback):
    def validate_start(self) -> tuple[det.Preflight, bool, Path]:
        """Antes de qualquer efeito colateral: só leitura e recusas."""
        pre = det.detect(self.run)
        env_path = self.root / ENV_FILE
        reuse = pre.stack_exists or env_path.exists()
        if (self.update_only or self.update) and not pre.stack_exists:
            raise Stop(f"{'--update' if self.update else '--update-only'} exige a stack '{STACK}' já publicada.")
        if self.yes and not reuse:
            raise Stop("--yes não cobre a primeira instalação: ela precisa de domínio, SMTP e senhas.")
        if pre.stack_exists and not env_path.exists():
            raise Stop(f"A stack '{STACK}' existe, mas {env_path} não. Restaure o arquivo e rode de novo.")
        self.choose_update(pre, env_path)
        return pre, reuse, env_path

    def choose_update(self, pre: det.Preflight, env_path: Path) -> None:
        """Atualização rápida: pedida por --update, ou oferecida (um [S/n]) quando a instalação está completa."""
        missing = upd.missing_required(read_env_text(env_path)) if env_path.exists() else list(upd.REQUIRED_ENV)
        if self.update and missing:
            raise Stop(f"--update exige um {ENV_FILE} completo; faltam: {', '.join(missing)}. Rode sem --update.")
        if self.update or not (pre.stack_exists and not missing):
            return
        self.say("Instalação existente e completa: nada será perguntado de novo (domínio, SMTP, DEPS, OpenAI, S3...).")
        if not (self.yes or self.dry_run or yes_no(self, "Atualizar agora, reaproveitando tudo?", True)):
            raise Stop("Cancelado pelo operador.")
        self.update = True

    def execute(self) -> int:
        pre, reuse, env_path = self.validate_start()
        pre = self.ensure_docker(pre)
        self.old_credentials = sorted(self.secure_dir.glob("credenciais-novos-*"))
        self.remind_old_credentials()
        self.check_ports(pre)
        self.ensure_swarm(pre)
        if pre.host_postgres:
            self.say("Nota: há um Postgres no host. Ele não é usado; a stack usa o Postgres próprio dela.")
        self.say("Modo: " + ("ATUALIZAÇÃO (reaproveita .env e secrets)." if reuse else "primeira instalação."))
        defaults = self.ensure_traefik(pre, "")
        env, provided = self.load_or_collect_env(reuse, defaults)
        code = 1
        try:
            digests = self.prepare_update(pre, env, env_path) if reuse else None  # só leitura: nada é criado antes
            self.provision_secrets(reuse, env, provided, pre)
            code = self.publish(pre, reuse, env, env_path, digests)
            return code
        finally:
            self.registry_logout()
            if code != 0 and self.credential_files:
                self.say("Secrets novos foram criados nesta execução e NÃO foram impressos. O arquivo com os valores está em: "
                         + ", ".join(str(p) for p in self.credential_files))
            if code != 0:
                self.remind_old_credentials()

    def remind_old_credentials(self) -> None:
        if self.old_credentials:
            self.say("ATENÇÃO: há arquivos de credenciais de execuções anteriores: "
                     + ", ".join(str(p) for p in self.old_credentials)
                     + ". Se uma execução falhou depois de criar secrets, a chave (ex.: pii_encryption_key) pode estar "
                     "neles: confira e guarde antes de apagar.")

    def prepare_update(self, pre: det.Preflight, env: dict[str, str], env_path: Path) -> dict[str, str]:
        """Resolve as imagens, reconcilia o .env, confere a stack, mostra o resumo e pede o confirma. Não muda o servidor."""
        old_text = read_env_text(env_path)
        self.previous = self.read_previous(pre, old_text)
        self.registry_login()
        digests = self.resolve_digests(env)
        plan = upd.plan_env(old_text)
        self.reconcile_env(env, plan)
        added_asaas = asaas.missing_keys(old_text)
        for key in added_asaas:  # ausentes entram vazias; preenchidas nunca são tocadas
            env[key] = self.reconciled[key] = ""
        self.secret_values |= asaas.secret_values(old_text)
        self.preflight_stack({**env, **digests})
        head = self.run(["git", "-C", str(self.root), "rev-parse", "HEAD"])[1].strip()
        note, pending = upd.migrations_note(self.run, self.root, env.get("CS_DEPLOYED_SHA", ""))
        for line in upd.render_summary(
                domain=env["APP_DOMAIN"], previous=self.previous, target=head, secrets=det.missing_secrets(pre.existing_secrets),
                plan=plan, migrations=note, values=self.reconciled, card_table=env.get("CARD_FEE_TABLE", "")):
            self.say(line)
        for line in asaas.status_lines(old_text, added_asaas):
            self.say(line)
        self.confirm_update(pending)
        return digests

    def read_previous(self, pre: det.Preflight, old_text: str) -> str | None:
        """Digest do app no ar (sem ele não há rollback). Falhou: usa o do .env.production; sem isso, para sem mudar nada."""
        if not pre.stack_exists:
            return None
        found = self.current_digest()
        if found:
            return found
        fallback = det.parse_env(old_text).get("REINO_IMAGE_DIGEST", "")
        if sp._DIGEST.match(fallback):
            self.say("AVISO: não consegui ler o digest do serviço no Swarm; uso REINO_IMAGE_DIGEST do .env.production anterior.")
            return fallback
        raise Stop("Não consegui descobrir a versão atual do app ('docker service inspect' falhou e o .env.production não tem "
                   "REINO_IMAGE_DIGEST válido). Sem ela não há rollback. Nada foi alterado.")

    def preflight_stack(self, values: dict[str, str]) -> None:
        """`docker stack config` com o env mesclado: pega variável obrigatória faltando antes de criar secrets."""
        code, out = self.run(["docker", "stack", "config", "-c", str(self.root / "docker-stack.yml")],
                             env={**self.environ, **values}, cwd=self.root)
        if code == 0:
            self.ok("Stack: todas as variáveis obrigatórias têm valor")
            return
        low = out.lower()
        if code == 127 or "unknown command" in low or "not a docker command" in low:
            self.say("AVISO: 'docker stack config' não está disponível; pulei a checagem das variáveis obrigatórias.")
            return
        raise Stop("O docker-stack.yml não fecha com o .env.production mesclado (variável obrigatória faltando?). "
                   f"Nada foi alterado.\n{out[-400:]}")

    def confirm_update(self, pending: bool) -> None:
        """Migrations não voltam: sem backup afirmado, --yes para e o modo interativo assume NÃO."""
        if self.dry_run:
            return
        question = f"Aplicar a atualização da stack '{STACK}'?"
        if pending and self.yes:
            if not (self.confirm_backup or self.environ.get("CS_BACKUP_OK") == "1"):
                raise Stop("Pode haver migrations pendentes e elas não voltam. --yes só roda com backup recente afirmado: "
                           "faça o backup (deploy.md, passo 4.5) e rode de novo com --confirm-backup (ou CS_BACKUP_OK=1).")
            self.say("Backup recente afirmado pelo operador (--confirm-backup / CS_BACKUP_OK=1).")
        if not self.confirm(question + (" Há migrations que não voltam: só digite 's' com backup recente." if pending else ""),
                            not pending):
            raise Stop("Cancelado pelo operador.")

    def reconcile_env(self, env: dict[str, str], plan: upd.EnvPlan) -> None:
        """Define o valor das variáveis novas em `env` e em `self.reconciled` (gravadas no publish). Só toca ausentes/vazias/inválidas."""
        for key in plan.added + plan.filled + plan.invalid:
            value = upd.NEW_VARS[key]
            if key in plan.invalid:
                if self.yes:
                    raise Stop(f"{key}='{env.get(key, '')}' é inválida ou ilegível e --yes não pode perguntar. "
                               f"Corrija no {ENV_FILE}.")
                value = self.ask(upd.PROMPTS[key], value, upd.VALIDATORS[key])
            elif key in plan.filled:
                self.say(f"AVISO: {key} estava vazia; vou preencher com {value} (a stack exige o valor).")
            env[key] = self.reconciled[key] = value

    def record_deployed(self, env_path: Path) -> None:
        """Guarda o commit no ar: a próxima atualização usa para listar as migrations novas."""
        code, sha = self.run(["git", "-C", str(self.root), "rev-parse", "HEAD"])
        if code != 0 or not upd._SHA.match(sha.strip()):
            return
        text = read_env_text(env_path)
        new = det.set_env_value(text, "CS_DEPLOYED_SHA", sha.strip())
        if new != text:
            write_env_atomic(env_path, new)

    def publish(self, pre: det.Preflight, reuse: bool, env: dict[str, str], env_path: Path,
                digests: dict[str, str] | None = None) -> int:
        if digests is None:
            self.registry_login()
            digests = self.resolve_digests(env)
        ok, detail = det.dns_check(env["APP_DOMAIN"], det.public_ip(self.run))
        self.dns_ok = ok
        (self.ok if ok else self.fail)("DNS: " + detail)
        if not ok and not self.update and not self.confirm("Continuar mesmo assim? O certificado pode não ser emitido."):
            raise Stop("Ajuste o DNS e rode de novo.")
        old_text = read_env_text(env_path) if env_path.exists() else ""
        new_text = upd.apply_values(old_text, self.reconciled)
        for key, value in digests.items():
            new_text = det.set_env_value(new_text, key, value)
        if not reuse and not self.confirm(f"Publicar a stack '{STACK}' em https://{env['APP_DOMAIN']}?"):
            raise Stop("Cancelado pelo operador.")
        if not self.act("gravando digests e rodando 'docker stack deploy'"):
            return 0
        if reuse:
            self.say(f"Cópia do {ENV_FILE} anterior: {backup_env(env_path, self.stamp())} (0600).")
            write_env_atomic(env_path, new_text)
        else:
            write_env_atomic(env_path, sp.render_env({**env, **digests}))
        code, out = self.deploy({**env, **digests})
        self.registry_logout()
        if code != 0:
            self.fail("Deploy: 'docker stack deploy' falhou")
            self.say(out[-800:])
            if old_text:
                write_env_atomic(env_path, old_text)
            self.say("O 'docker stack deploy' falhou. Não reverti serviços automaticamente"
                     + (" (restaurei o .env.production anterior)" if old_text else "")
                     + ". Leia o erro acima, corrija e rode o instalador de novo.")
            return 1
        self.ok(f"Deploy: stack '{STACK}' publicada")
        names = det.service_names(STACK, self.run)
        return self.verify(env["APP_DOMAIN"], digests["REINO_IMAGE_DIGEST"], self.previous, old_text, env_path, names)

    def verify(self, domain: str, digest: str, previous: str | None, old_text: str, env_path: Path,
               names: dict[str, str]) -> int:
        t = self.timeouts
        checks = ver.run_checks(domain, digest, self.run, self.http, self.tls, self.say, self.sleep, self.clock,
                                names, t.get("migrate", 300), t.get("app", 420), t.get("http", 180))
        if checks and all(c.ok for c in checks) and len(checks) == ver.TOTAL_CHECKS:
            self.record_deployed(env_path)
            self.summary(domain, checks)
            return 0
        service = ver.failing_service(checks, names)
        self.say(f"\nFALHOU. Últimas {ver.LOG_LINES} linhas de {service}:")
        self.say(ver.fetch_logs(service, self.run, self.secret_values))
        if checks and checks[-1].critical:
            self.rollback(previous, digest, old_text, env_path, names)
        else:
            self.guidance(checks[-1].name if checks else "?", domain)
        return 1

    def guidance(self, step: str, domain: str) -> None:
        self.say(f"\nA etapa '{step}' falhou, mas a migração e o app estão no ar. Não fiz rollback.")
        if not self.dns_ok:
            self.say(f"Causa provável: o DNS de {domain} não aponta para este servidor (o Let's Encrypt não emite).")
        self.say("Confira: DNS, 'docker service logs traefik_traefik', a rede/resolver do .env.production "
                 "e as labels do serviço. Depois rode o instalador de novo (ele é idempotente).")

    def summary(self, domain: str, checks: list[ver.Check]) -> None:
        if self.dns_ok:
            self.say(f"\nPRONTO: https://{domain}")
        else:
            self.say(f"\napp OK localmente; DNS ainda não aponta para este servidor. "
                     f"https://{domain} só abre quando o DNS apontar.")
        for c in checks:
            self.say(f"  OK {c.name}: {c.detail}")
        self.say("Próximos passos (backup manual, drill, monitor): docs/operations/deploy.md, seção 4.")
        if self.update:
            self.say("Ainda manual: revisar CARD_FEE_TABLE; guardar a chave PII; trocar a chave do Asaas; teste real de "
                     "cartão e de Pix com taxa (docs/operations/payments.md, seção 7).")
        self.show_credentials()
        self.remind_old_credentials()

    def show_credentials(self) -> None:
        """Imprime as credenciais desta execução. Intencional: usa `out` direto, sem `redact`."""
        for path in self.credential_files:
            self.out("\n" + "=" * 64 + "\nCREDENCIAIS DESTA EXECUÇÃO: salve AGORA em um gerenciador de senhas.\n"
                     "Elas não serão mostradas de novo. Não há token do GitHub neste bloco.\n" + "=" * 64)
            self.out(path.read_text(encoding="utf-8").rstrip("\n"))
            self.out("=" * 64 + "\nFIM DAS CREDENCIAIS\n" + "=" * 64)
            if self.yes:
                self.say(f"--yes: o arquivo NÃO foi apagado: {path}")
            elif self.input_fn(f"Credenciais salvas? Apagar o arquivo {path} agora? [s/N]: ").strip().lower() in ("s", "sim"):
                path.unlink(missing_ok=True)
                self.say(f"Arquivo apagado: {path}")
            else:
                self.say(f"O arquivo continua em {path}. Apague-o depois de salvar.")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--dry-run", action="store_true", help="detecta e mostra o plano, sem mudar nada")
    parser.add_argument("--yes", action="store_true", help="aceita os padrões nas confirmações (só atualização)")
    parser.add_argument("--update", action="store_true",
                        help="atualização rápida: reaproveita .env e secrets, faz só as migrations e o que faltar, um confirma")
    parser.add_argument("--confirm-backup", action="store_true",
                        help="afirma que há backup recente: libera --yes quando há migrations pendentes")
    parser.add_argument("--update-only", action="store_true", help="só atualiza uma stack já publicada")
    args = parser.parse_args(argv)
    token, user = os.environ.get("CS_GHCR_TOKEN", ""), os.environ.get("CS_GH_USER", "")
    for name in GH_ENV:
        os.environ.pop(name, None)
    if os.name == "posix" and os.geteuid() != 0 and not args.dry_run:
        print("ERRO: rode como root (sudo).", file=sys.stderr)
        return 1
    lock_fd = None  # mantido aberto até o fim do processo
    if not args.dry_run and os.environ.get("CS_LOCK_HELD") != "1":  # install.sh já trava com flock e marca CS_LOCK_HELD
        try:
            lock_fd = acquire_lock()
        except (Stop, OSError) as exc:
            print(f"ERRO: {exc}", file=sys.stderr)
            return 1
    installer = Installer(yes=args.yes, dry_run=args.dry_run, update_only=args.update_only, update=args.update,
                          confirm_backup=args.confirm_backup, gh_token=token, gh_user=user)
    try:
        return installer.execute()
    except (Stop, OSError, RuntimeError) as exc:
        installer.say(f"ERRO: {exc}")
        return 1
    finally:
        if lock_fd is not None:
            os.close(lock_fd)


if __name__ == "__main__":
    sys.exit(main())
