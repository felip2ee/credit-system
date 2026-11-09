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
        "OPENAI_MODEL": "gpt-4o",
        "BACKUP_ALERT_TO": "ops@exemplo.com.br",
        "OPS_ALERT_TO": "ops@exemplo.com.br",
        "RESTIC_S3_ENDPOINT": "s3.us-west-004.backblazeb2.com",
        "RESTIC_S3_BUCKET": "reino-backup",
        "WHATSAPP_DRIVER": "",
        "WHATSAPP_PHONE_NUMBER_ID": "",
        "WHATSAPP_GRAPH_VERSION": "v21.0",
        "WEB_PUSH_VAPID_PUBLIC_KEY": "",
        "WEB_PUSH_VAPID_SUBJECT": "",
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
    "whatsapp_access_token": "wa-token-test",
    "whatsapp_app_secret": "wa-app-secret-test",
    "restic_s3_access_key": "s3-access-key-test",
    "restic_s3_secret_key": "s3-secret-key-test",
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

    def test_s3_endpoint_must_be_host_or_url_without_scheme_bucket_without_slash(self):
        for good in ["s3.us-west-004.backblazeb2.com", "minio.local:9000"]:
            self.assertTrue(sp.valid_s3_endpoint(good), good)
        for bad in ["", "https://s3.example.com", "s3.example.com/bucket", "host with space", "host:abc"]:
            self.assertFalse(sp.valid_s3_endpoint(bad), bad)
        for good in ["reino-backup", "a.b-c1"]:
            self.assertTrue(sp.valid_s3_bucket(good), good)
        for bad in ["", "a", "-ab", "ab-", "Ab", "a/b", "a b"]:
            self.assertFalse(sp.valid_s3_bucket(bad), bad)

    def test_superadmin_password(self):
        self.assertTrue(sp.valid_superadmin_password("x" * 12))
        self.assertFalse(sp.valid_superadmin_password("x" * 11))
        self.assertFalse(sp.valid_superadmin_password("x" * 129))


class Building(unittest.TestCase):
    def test_generated_secrets_and_dsns(self):
        values = sp.build_secrets(PROVIDED)
        self.assertEqual(set(values), set(sp.SECRET_NAMES))
        self.assertEqual(len(values["better_auth_secret"]), 64)
        self.assertIn(f"app_runtime:{values['app_runtime_password']}@reino-db:5432/credit_system", values["database_url"])
        self.assertIn(f"postgres:{values['postgres_password']}@reino-db:5432/credit_system", values["database_owner_url"])
        self.assertNotEqual(values["postgres_password"], values["app_runtime_password"])

    def test_pii_key_is_a_32_byte_k1_ring_and_not_reused(self):
        import base64
        key = sp.build_secrets(PROVIDED)["pii_encryption_key"]
        prefix, _, b64 = key.partition(":")
        self.assertEqual(prefix, "k1")
        self.assertEqual(len(base64.b64decode(b64, validate=True)), 32)
        self.assertNotEqual(key, sp.build_secrets(PROVIDED)["pii_encryption_key"])

    def test_credentials_warn_about_pii_key(self):
        values = sp.build_secrets(PROVIDED)
        text = sp.render_credentials({}, {**values})
        self.assertIn("pii_encryption_key=k1:", text)
        self.assertIn("ilegíveis", text)

    def test_generates_notification_secrets(self):
        values = sp.build_secrets(PROVIDED)
        for name in ("notifications_dispatch_secret", "whatsapp_verify_token"):
            self.assertEqual(len(values[name]), 64, name)
        self.assertEqual(values["whatsapp_access_token"], "wa-token-test")
        self.assertNotEqual(values["notifications_dispatch_secret"], values["whatsapp_verify_token"])

    def test_empty_whatsapp_tokens_are_accepted(self):
        values = sp.build_secrets({**PROVIDED, "whatsapp_access_token": "", "whatsapp_app_secret": ""})
        self.assertEqual(values["whatsapp_access_token"], sp.WHATSAPP_OFF_PLACEHOLDER)
        self.assertEqual(values["whatsapp_app_secret"], sp.WHATSAPP_OFF_PLACEHOLDER)

    def test_push_private_key_is_a_secret_with_off_placeholder(self):
        self.assertIn("web_push_vapid_private_key", sp.SECRET_NAMES)
        self.assertEqual(sp.build_secrets(PROVIDED)["web_push_vapid_private_key"], sp.PUSH_OFF_PLACEHOLDER)
        key = "k" * 43
        self.assertEqual(sp.build_secrets({**PROVIDED, "web_push_vapid_private_key": key})["web_push_vapid_private_key"], key)
        self.assertTrue(sp.valid_vapid_private("") and sp.valid_vapid_private(key) and not sp.valid_vapid_private("curta"))
        self.assertTrue(sp.valid_vapid_public("B" * 87) and not sp.valid_vapid_public("B" * 86))
        self.assertTrue(sp.valid_vapid_subject("mailto:a@b.com") and not sp.valid_vapid_subject("http://x"))
        for k in ("WEB_PUSH_VAPID_PUBLIC_KEY", "WEB_PUSH_VAPID_SUBJECT"):
            self.assertIn(k, sp.ENV_KEYS)
        self.assertNotIn("WEB_PUSH_VAPID_PRIVATE_KEY", sp.ENV_KEYS)

    def test_env_keys_deliver_the_asaas_fee_settings(self):
        for key in ("CARD_FEE_TABLE", "CARD_MIN_INSTALLMENT_CENTS", "PIX_FEE_CENTS"):
            self.assertIn(key, sp.ENV_KEYS)
        self.assertIn("PIX_FEE_CENTS=199\n", sp.render_env(answers()))
        self.assertIn("PIX_FEE_CENTS=0\n", sp.render_env(answers(PIX_FEE_CENTS="0")))
        self.assertIn("PIX_FEE_CENTS=250\n", sp.render_env(answers(PIX_FEE_CENTS="250")))
        self.assertIn("PIX_FEE_CENTS=199\n", sp.render_credentials(answers(), {n: "x" for n in sp.SECRET_NAMES}))

    def test_env_keys_have_whatsapp_settings(self):
        for key in ("WHATSAPP_DRIVER", "WHATSAPP_PHONE_NUMBER_ID", "WHATSAPP_GRAPH_VERSION"):
            self.assertIn(key, sp.ENV_KEYS)

    def test_setup_does_not_ask_for_deps_products(self):
        asked = {q[0] for q in sp.QUESTIONS}
        for key in ("DEPS_PRODUTO_PF", "DEPS_PRODUTO_PJ"):
            self.assertNotIn(key, sp.ENV_KEYS)
            self.assertNotIn(key, asked)

    def test_whatsapp_driver_defaults_to_off_and_refuses_fake(self):
        _, _, default, validator = next(q for q in sp.QUESTIONS if q[0] == "WHATSAPP_DRIVER")
        self.assertEqual(default, "")
        self.assertTrue(validator("") and validator("meta"))
        self.assertFalse(validator("fake"))

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


class S3Backup(unittest.TestCase):
    def test_env_file_has_restic_s3_endpoint_bucket_and_ops_alert_to(self):
        env = sp.render_env(answers())
        self.assertIn("RESTIC_S3_ENDPOINT=s3.us-west-004.backblazeb2.com\n", env)
        self.assertIn("RESTIC_S3_BUCKET=reino-backup\n", env)
        self.assertIn("OPS_ALERT_TO=ops@exemplo.com.br\n", env)

    def test_s3_keys_are_docker_secrets_and_never_in_env_file(self):
        values = sp.build_secrets(PROVIDED)
        self.assertEqual(values["restic_s3_access_key"], "s3-access-key-test")
        self.assertEqual(values["restic_s3_secret_key"], "s3-secret-key-test")
        self.assertIn("restic_s3_access_key", sp.SECRET_NAMES)
        self.assertIn("restic_s3_secret_key", sp.SECRET_NAMES)
        env = sp.render_env(answers())
        self.assertNotIn("s3-access-key-test", env)
        self.assertNotIn("s3-secret-key-test", env)
        self.assertFalse(any(k.startswith("restic_s3_") for k in sp.ENV_KEYS))

    def test_credentials_file_has_s3_keys(self):
        creds = sp.render_credentials(answers(), sp.build_secrets(PROVIDED))
        self.assertIn("restic_s3_access_key=s3-access-key-test", creds)
        self.assertIn("restic_s3_secret_key=s3-secret-key-test", creds)

    def test_ops_alert_to_defaults_to_backup_alert_to(self):
        given = answers(BACKUP_ALERT_TO="backup@exemplo.com.br")
        by_prompt = {prompt: key for key, prompt, _, _ in sp.QUESTIONS}
        seen = {}

        def input_fn(text):
            prompt = text.split(" [")[0].rstrip(": ")
            key = by_prompt[prompt]
            seen[key] = text
            return "" if key == "OPS_ALERT_TO" else given[key]

        env_values, _ = sp.collect(FakeRunner(), input_fn, lambda prompt: "k" * 43 if "VAPID" in prompt else "x" * 12)
        self.assertIn("[backup@exemplo.com.br]", seen["OPS_ALERT_TO"])
        self.assertEqual(env_values["OPS_ALERT_TO"], "backup@exemplo.com.br")


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
