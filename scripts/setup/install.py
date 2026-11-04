#!/usr/bin/env python3
"""Instalador da Plataforma Bureau: detecta o servidor, configura, faz o deploy e verifica.

Chamado por scripts/setup/install.sh (root). Reaproveita setup_production.py para segredos e .env.
Uso:  python3 scripts/setup/install.py [--dry-run] [--yes] [--update-only]
Token do GHCR (só read:packages): variável CS_GHCR_TOKEN (nunca argv). Usuário: CS_GH_USER.
As variáveis CS_GH_* saem do ambiente na partida e nunca chegam a processos filhos.
"""
from __future__ import annotations

import argparse
import os
import sys
from pathlib import Path

import install_detect as det
import install_verify as ver
import setup_production as sp
from install_core import ENV_FILE, GH_ENV, STACK, Stop, default_runner  # noqa: F401 (re-export para testes)
from install_secrets import Secrets


class Installer(Secrets):
    def deploy(self, values: dict[str, str]) -> tuple[int, str]:
        env = {**self.environ, **values}
        return self.run(["docker", "stack", "deploy", "--with-registry-auth", "-c",
                         str(self.root / "docker-stack.yml"), STACK], env=env, cwd=self.root)

    def validate_start(self) -> tuple[det.Preflight, bool, Path]:
        """Antes de qualquer efeito colateral: só leitura e recusas."""
        pre = det.detect(self.run)
        env_path = self.root / ENV_FILE
        reuse = pre.stack_exists or env_path.exists()
        if self.update_only and not pre.stack_exists:
            raise Stop(f"--update-only exige a stack '{STACK}' já publicada.")
        if self.yes and not reuse:
            raise Stop("--yes não cobre a primeira instalação: ela precisa de domínio, SMTP e senhas.")
        if pre.stack_exists and not env_path.exists():
            raise Stop(f"A stack '{STACK}' existe, mas {env_path} não. Restaure o arquivo e rode de novo.")
        return pre, reuse, env_path

    def execute(self) -> int:
        pre, reuse, env_path = self.validate_start()
        pre = self.ensure_docker(pre)
        self.check_ports(pre)
        self.ensure_swarm(pre)
        if pre.host_postgres:
            self.say("Nota: há um Postgres no host. Ele não é usado; a stack usa o Postgres próprio dela.")
        self.say("Modo: " + ("ATUALIZAÇÃO (reaproveita .env e secrets)." if reuse else "primeira instalação."))
        defaults = self.ensure_traefik(pre, "")
        env, provided = self.load_or_collect_env(reuse, defaults)
        self.provision_secrets(reuse, env, provided, pre)
        try:
            return self.publish(pre, reuse, env, env_path)
        finally:
            self.registry_logout()

    def publish(self, pre: det.Preflight, reuse: bool, env: dict[str, str], env_path: Path) -> int:
        self.registry_login()
        digests = self.resolve_digests(env)
        ok, detail = det.dns_check(env["APP_DOMAIN"], det.public_ip(self.run))
        self.dns_ok = ok
        self.say(("DNS: " if ok else "AVISO de DNS: ") + detail)
        if not ok and not self.confirm("Continuar mesmo assim? O certificado pode não ser emitido."):
            raise Stop("Ajuste o DNS e rode de novo.")
        old_text = env_path.read_text(encoding="utf-8") if env_path.exists() else ""
        previous = self.current_digest() if pre.stack_exists else None
        new_text = old_text
        for key, value in digests.items():
            new_text = det.set_env_value(new_text, key, value)
        if not self.confirm(f"Publicar a stack '{STACK}' em https://{env['APP_DOMAIN']}?"):
            raise Stop("Cancelado pelo operador.")
        if not self.act("gravando digests e rodando 'docker stack deploy'"):
            return 0
        if reuse:
            env_path.write_text(new_text, encoding="utf-8")
            os.chmod(env_path, 0o600)
        else:
            env_path.write_text(sp.render_env({**env, **digests}), encoding="utf-8")
            os.chmod(env_path, 0o600)
        code, out = self.deploy({**env, **digests})
        self.registry_logout()
        if code != 0:
            self.say(out[-800:])
            if old_text:
                env_path.write_text(old_text, encoding="utf-8")
            self.say("O 'docker stack deploy' falhou. Não reverti serviços automaticamente"
                     + (" (restaurei o .env.production anterior)" if old_text else "")
                     + ". Leia o erro acima, corrija e rode o instalador de novo.")
            return 1
        names = det.service_names(STACK, self.run)
        return self.verify(env["APP_DOMAIN"], digests["REINO_IMAGE_DIGEST"], previous, old_text, env_path, names)

    def current_digest(self) -> str | None:
        app = det.service_names(STACK, self.run)["reino_app"]
        code, out = self.run(["docker", "service", "inspect", app, "--format",
                              "{{.Spec.TaskTemplate.ContainerSpec.Image}}"])
        return det.parse_digest(out) if code == 0 else None

    def rollback(self, previous: str | None, new_digest: str, old_text: str, env_path: Path,
                 names: dict[str, str]) -> None:
        """Volta todos os serviços: restaura o .env.production antigo e refaz o deploy (idempotente)."""
        if not previous:
            self.say(f"Primeira instalação: não há versão anterior. A stack ficou no ar para inspeção; "
                     f"para remover: docker stack rm {STACK} (os volumes ficam).")
            return
        if previous == new_digest:
            self.say("O digest novo é igual ao anterior: não há o que reverter.")
            return
        state = ver.update_state(names["reino_app"], self.run)
        if state.startswith("rollback"):
            self.say(f"O Swarm já reverteu o app ({state}). Vou alinhar os outros serviços ao .env anterior.")
        self.say("==> restaurando o .env.production anterior e refazendo o deploy")
        env_path.write_text(old_text, encoding="utf-8")
        os.chmod(env_path, 0o600)
        try:
            self.docker_login()
            code, out = self.deploy(det.parse_env(old_text))
        finally:
            self.registry_logout()
        self.say("Rollback concluído: stack refeita com a versão anterior." if code == 0
                 else f"O deploy do rollback falhou. Faça à mão (seção 6 do runbook):\n{out[-400:]}")
        self.say("Migrations não voltam: veja docs/operations/deploy.md, seção 6.")

    def verify(self, domain: str, digest: str, previous: str | None, old_text: str, env_path: Path,
               names: dict[str, str]) -> int:
        t = self.timeouts
        checks = ver.run_checks(domain, digest, self.run, self.http, self.tls, self.say, self.sleep, self.clock,
                                names, t.get("migrate", 300), t.get("app", 420), t.get("http", 180))
        if checks and all(c.ok for c in checks) and len(checks) == ver.TOTAL_CHECKS:
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
        for path in self.credential_files:
            self.say(f"Credenciais: {path}")
        if self.credential_files:
            self.say("Mova esses arquivos para um gerenciador de senhas e APAGUE-os do servidor "
                     f"({self.secure_dir}).")
        self.say("Próximos passos (backup manual, drill, monitor): docs/operations/deploy.md, seção 4.")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--dry-run", action="store_true", help="detecta e mostra o plano, sem mudar nada")
    parser.add_argument("--yes", action="store_true", help="aceita os padrões nas confirmações (só atualização)")
    parser.add_argument("--update-only", action="store_true", help="só atualiza uma stack já publicada")
    args = parser.parse_args(argv)
    token, user = os.environ.get("CS_GHCR_TOKEN", ""), os.environ.get("CS_GH_USER", "")
    for name in GH_ENV:
        os.environ.pop(name, None)
    if os.name == "posix" and os.geteuid() != 0 and not args.dry_run:
        print("ERRO: rode como root (sudo).", file=sys.stderr)
        return 1
    installer = Installer(yes=args.yes, dry_run=args.dry_run, update_only=args.update_only,
                          gh_token=token, gh_user=user)
    try:
        return installer.execute()
    except (Stop, FileExistsError, RuntimeError) as exc:
        installer.say(f"ERRO: {exc}")
        return 1


if __name__ == "__main__":
    sys.exit(main())
