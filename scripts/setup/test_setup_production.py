import os
import stat
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import setup_production as sp  # noqa: E402


class FakeRunner:
    def __init__(self, existing=(), subnet="10.0.1.0/24"):
        self.calls = []
        self.existing = set(existing)
        self.subnet = subnet

    def __call__(self, args, input=None):
        self.calls.append((list(args), input))
        if args[:3] == ["docker", "secret", "inspect"]:
            return 0 if args[3] in self.existing else 1, ""
        if args[:3] == ["docker", "network", "inspect"]:
            return 0, f'[{{"Subnet":"{self.subnet}"}}]'
        return 0, ""


def answers(**overrides):
    base = {
        "APP_DOMAIN": "app.exemplo.com.br",
        "TRAEFIK_NETWORK": "RainhaNet",
        "TRAEFIK_CERT_RESOLVER": "letsencryptresolver",
        "TRAEFIK_PROXY_CIDR": "10.0.1.0/24",
        "SMTP_HOST": "smtp.exemplo.com",
        "SMTP_PORT": "465",
        "SMTP_SECURE": "true",
        "SMTP_USER": "no-reply@exemplo.com.br",
        "SMTP_FROM": "Rainha do Crédito <no-reply@exemplo.com.br>",
        "SUPERADMIN_EMAIL": "felipe@exemplo.com.br",
        "DEPS_API_BASE_URL": "https://api-portal.deps.com.br",
        "DEPS_API_EMAIL": "deps@exemplo.com.br",
        "DEPS_API_CENTRO_CUSTOS": "",
        "DEPS_PRODUTO_PF": "Smart PF 002",
        "DEPS_PRODUTO_PJ": "Smart PJ 010",
        "OPENAI_MODEL": "gpt-4o",
        "BACKUP_ALERT_TO": "ops@exemplo.com.br",
        "REINO_IMAGE_OWNER": "felip2ee",
        "REINO_IMAGE_DIGEST": "",
        "REINO_BACKUP_DIGEST": "",
    }
    base.update(overrides)
    return base


PROVIDED = {
    "smtp_pass": "smtp $ecret 'x'",
    "deps_api_password": "deps-pw",
    "openai_api_key": "sk-test",
    "superadmin_password": "superadmin-password-1",
}


class Validators(unittest.TestCase):
    def test_domain(self):
        self.assertTrue(sp.valid_domain("app.exemplo.com.br"))
        for bad in ["", "exemplo", "-a.com", "a..com", "https://a.com"]:
            self.assertFalse(sp.valid_domain(bad), bad)

    def test_email(self):
        self.assertTrue(sp.valid_email("a@b.co"))
        self.assertFalse(sp.valid_email("a@b"))

    def test_port(self):
        self.assertTrue(sp.valid_port("465"))
        for bad in ["0", "65536", "abc", ""]:
            self.assertFalse(sp.valid_port(bad), bad)

    def test_cidr(self):
        self.assertTrue(sp.valid_cidr("10.0.0.0/8"))
        self.assertFalse(sp.valid_cidr("10.0.0.0"))
        self.assertFalse(sp.valid_cidr("nope"))

    def test_digest(self):
        self.assertTrue(sp.valid_digest(""))
        self.assertTrue(sp.valid_digest("a" * 64))
        self.assertFalse(sp.valid_digest("sha256:" + "a" * 64))

    def test_superadmin_password(self):
        self.assertTrue(sp.valid_superadmin_password("x" * 12))
        self.assertFalse(sp.valid_superadmin_password("x" * 11))
        self.assertFalse(sp.valid_superadmin_password("x" * 129))


class Building(unittest.TestCase):
    def test_generated_secrets_and_dsns(self):
        values = sp.build_secrets(PROVIDED)
        self.assertEqual(set(values), set(sp.SECRET_NAMES))
        self.assertEqual(len(values["better_auth_secret"]), 64)
        self.assertIn(f"app_runtime:{values['app_runtime_password']}@postgres:5432/credit_system", values["database_url"])
        self.assertIn(f"postgres:{values['postgres_password']}@postgres:5432/credit_system", values["database_owner_url"])
        self.assertNotEqual(values["postgres_password"], values["app_runtime_password"])

    def test_generates_superadmin_password_when_blank(self):
        values = sp.build_secrets({**PROVIDED, "superadmin_password": ""})
        self.assertTrue(sp.valid_superadmin_password(values["superadmin_password"]))

    def test_env_file_survives_shell_sourcing(self):
        env = sp.render_env(answers(SMTP_FROM="Rainha do Crédito <no-reply@x.com> $HOME 'q'"))
        with tempfile.TemporaryDirectory() as d:
            path = Path(d) / ".env.production"
            path.write_text(env, encoding="utf-8")
            out = subprocess.run(
                ["sh", "-c", f'set -a; . "{path}"; printf %s "$SMTP_FROM"'],
                capture_output=True, text=True, check=True,
            ).stdout
        self.assertEqual(out, "Rainha do Crédito <no-reply@x.com> $HOME 'q'")

    def test_env_file_has_only_non_secret_keys(self):
        env = sp.render_env(answers())
        keys = {line.split("=", 1)[0] for line in env.splitlines() if line and not line.startswith("#")}
        self.assertEqual(keys, set(sp.ENV_KEYS))
        for secret in PROVIDED.values():
            self.assertNotIn(secret, env)


class Applying(unittest.TestCase):
    def test_secrets_go_through_stdin_and_existing_are_skipped(self):
        runner = FakeRunner(existing={"postgres_password"})
        values = sp.build_secrets(PROVIDED)
        report = sp.create_docker_secrets(values, runner)
        self.assertIn("postgres_password", report.skipped)
        self.assertEqual(len(report.created), len(sp.SECRET_NAMES) - 1)
        for args, stdin in runner.calls:
            if args[:3] == ["docker", "secret", "create"]:
                self.assertEqual(args[4], "-")
                self.assertEqual(stdin, values[args[3]])
                for value in values.values():
                    self.assertNotIn(value, args)

    def test_detects_proxy_cidr(self):
        self.assertEqual(sp.detect_proxy_cidr("RainhaNet", FakeRunner(subnet="10.0.9.0/24")), "10.0.9.0/24")

    def test_write_outputs_is_private_and_refuses_overwrite(self):
        with tempfile.TemporaryDirectory() as d:
            out = Path(d)
            sp.write_outputs(out, answers(), sp.build_secrets(PROVIDED), force=False)
            for name in (".env.production", "credenciais-GUARDAR.txt"):
                mode = stat.S_IMODE(os.stat(out / name).st_mode)
                self.assertEqual(mode, 0o600, name)
            with self.assertRaises(FileExistsError):
                sp.write_outputs(out, answers(), sp.build_secrets(PROVIDED), force=False)
            sp.write_outputs(out, answers(), sp.build_secrets(PROVIDED), force=True)

    def test_dry_run_creates_nothing(self):
        with tempfile.TemporaryDirectory() as d:
            runner = FakeRunner()
            sp.apply(Path(d), answers(), sp.build_secrets(PROVIDED), runner, dry_run=True, no_docker=False, force=False)
            self.assertEqual(list(Path(d).iterdir()), [])
            self.assertFalse(any(a[:3] == ["docker", "secret", "create"] for a, _ in runner.calls))


if __name__ == "__main__":
    unittest.main()
