"""Configuração e secrets do Docker: coleta, arquivos fora do git, criação com desfazer em falha."""
from __future__ import annotations

import os

import install_detect as det
import setup_production as sp
from install_collect import collect_installer
from install_core import ENV_FILE, Stop
from install_steps import Steps

OPTIONAL_KEYS = ("smtp_pass", "deps_api_password", "openai_api_key", "restic_s3_access_key",
                 "restic_s3_secret_key", "superadmin_password", "whatsapp_access_token",
                 "whatsapp_app_secret", "web_push_vapid_private_key")


class Secrets(Steps):
    def load_or_collect_env(self, reuse: bool, defaults: dict[str, str]) -> tuple[dict[str, str], dict[str, str]]:
        """Devolve (valores do env, segredos informados). Em reuso, lê .env.production."""
        env_path = self.root / ENV_FILE
        if reuse:
            values = det.parse_env(env_path.read_text(encoding="utf-8"))
            self.say(f"Reaproveitando {env_path}.")
            for key in ("TRAEFIK_NETWORK", "TRAEFIK_CERT_RESOLVER"):
                if defaults.get(key) and values.get(key) != defaults[key]:
                    self.say(f"AVISO: {key} no .env.production é '{values.get(key, '')}', "
                             f"mas o Traefik existente usa '{defaults[key]}'.")
            return values, {}
        return collect_installer(self, defaults)

    def check_secret_state(self, reuse: bool, pre: det.Preflight) -> None:
        existing = pre.existing_secrets
        if det.partial_db_secrets(existing):
            raise Stop("Só parte dos secrets do banco existe. Recriá-los quebraria a senha do Postgres.\n"
                       "Remova os secrets órfãos (docker secret rm ...) ou restaure os que faltam, e rode de novo.")
        if not (det.DB_SECRETS & existing) and pre.postgres_volumes:
            raise Stop("Não há secrets do banco, mas já existe volume de dados do Postgres "
                       f"({', '.join(pre.postgres_volumes)}). Secrets novos não abririam esse banco.\n"
                       "Restaure os secrets originais, ou remova o volume só se tiver certeza de que não há dados.")
        if reuse and existing and "restic_password" not in existing:
            raise Stop("O secret 'restic_password' não existe, mas outros sim. Uma senha nova tornaria os backups "
                       "existentes ilegíveis. Restaure o original (gerenciador de senhas) e rode de novo.")

    def provision_secrets(self, reuse: bool, env: dict[str, str], provided: dict[str, str], pre: det.Preflight) -> None:
        self.check_secret_state(reuse, pre)
        missing = det.missing_secrets(pre.existing_secrets)
        if reuse and missing:
            for name, prompt, validator, _ in sp.SECRET_QUESTIONS:
                if name not in missing:
                    continue
                if self.yes and not validator(""):
                    raise Stop(f"Falta o secret '{name}' e --yes não pode perguntar o valor. Rode sem --yes.")
                provided[name] = "" if self.yes else sp.ask_secret(prompt, validator, self.getpass_fn)
        if reuse and not missing:
            self.say("Todos os secrets já existem: nenhum será criado ou trocado.")
            return
        if reuse and "pii_encryption_key" in missing:
            self.say("AVISO: o secret 'pii_encryption_key' não existia; esta execução gera um novo. "
                     "Guarde o valor: sem ele os dados de pagamento cifrados ficam ilegíveis.")
        values = sp.build_secrets({k: provided.get(k, "") for k in OPTIONAL_KEYS} | provided)
        self.secret_values |= {values[n] for n in missing}
        if not self.act(f"criando {len(missing)} secret(s) do Docker"):
            return
        written = [] if reuse else self.write_first_install(env, values)
        try:
            report = sp.create_docker_secrets({n: values[n] for n in sp.SECRET_NAMES}, self.run)
        except sp.SecretCreationError as exc:
            self.undo_partial(exc.report.created, written)
            raise Stop(f"{exc}. Desfiz o que esta execução criou ({len(exc.report.created)} secret(s) e os arquivos "
                       "gerados). Corrija o Docker e rode de novo.") from exc
        self.say("Secrets criados: " + (", ".join(report.created) or "nenhum"))
        if report.skipped:
            self.say("AVISO: já existiam e NÃO foram alterados: " + ", ".join(report.skipped))
        if reuse and report.created:
            body = "\n".join(f"{n}={values[n]}" for n in report.created) + "\n"
            self.credential_files.append(self.secure_file(f"credenciais-novos-{self.stamp()}-GUARDAR.txt", body))
        elif not reuse and report.skipped:
            self.drop_skipped(self.credential_files[-1], set(report.skipped))

    def write_first_install(self, env: dict[str, str], values: dict[str, str]) -> list:
        """.env.production fica na raiz (a stack o lê); as credenciais vão para `secure_dir`."""
        env_path = self.root / ENV_FILE
        sp._write_private(env_path, sp.render_env(env), False)
        try:
            cred = self.secure_file(f"credenciais-{self.stamp()}-GUARDAR.txt", sp.render_credentials(env, values))
        except OSError:
            env_path.unlink(missing_ok=True)
            raise
        self.credential_files.append(cred)
        return [env_path, cred]

    def undo_partial(self, created: list[str], files: list) -> None:
        stuck = [n for n in created if self.run(["docker", "secret", "rm", n])[0] != 0]
        for path in files:
            path.unlink(missing_ok=True)
        self.credential_files.clear()
        if stuck:
            self.say("AVISO: não consegui remover estes secrets: " + ", ".join(stuck) + ". Remova com 'docker secret rm'.")

    @staticmethod
    def drop_skipped(path, skipped: set[str]) -> None:
        """Secrets que já existiam não estão em uso: tira os valores gerados do arquivo de credenciais."""
        keep = [line for line in path.read_text(encoding="utf-8").splitlines()
                if line.split("=", 1)[0] not in skipped
                and not (line.startswith("Superadmin:") and "superadmin_password" in skipped)]
        path.write_text("\n".join(keep) + "\n", encoding="utf-8")
        os.chmod(path, 0o600)
