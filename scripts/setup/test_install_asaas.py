"""Variáveis ASAAS_*: na stack, adicionadas vazias no --update, valores preenchidos intactos, resumo sem segredos."""
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import install_asaas as asa  # noqa: E402
import install_detect as det  # noqa: E402
from install_testkit import installer  # noqa: E402
from test_install_update import DNS_OK, make_old_root, old_env_text, srv  # noqa: E402

STACK = Path(__file__).resolve().parents[2] / "docker-stack.yml"
KEY = "aact_SECRETKEY_0123456789"
TOKEN32 = "a1b2c3d4e5f60718293a4b5c6d7e8f90"  # 32 caracteres
SHORT = "curto-demais-123"


def no_input(prompt):
    raise AssertionError(f"não devia perguntar: {prompt}")


class StackFile(unittest.TestCase):
    def test_app_receives_the_four_asaas_vars(self):
        text = STACK.read_text(encoding="utf-8")
        for line in ("ASAAS_DRIVER: ${ASAAS_DRIVER:-}", "ASAAS_API_BASE_URL: ${ASAAS_API_BASE_URL:-https://api.asaas.com}",
                     "ASAAS_API_KEY: ${ASAAS_API_KEY:-}", "ASAAS_WEBHOOK_TOKEN: ${ASAAS_WEBHOOK_TOKEN:-}"):
            self.assertIn(line, text)


class StatusLines(unittest.TestCase):
    def joined(self, text, added=()):
        return "\n".join(asa.status_lines(text, list(added)))

    def test_empty_driver_says_off(self):
        self.assertIn("Asaas: DESLIGADO (preencha ASAAS_DRIVER, ASAAS_API_KEY e ASAAS_WEBHOOK_TOKEN no .env.production)",
                      self.joined("ASAAS_DRIVER=\n"))

    def test_asaas_driver_warns_on_empty_short_or_placeholder_token_and_missing_key(self):
        base = f"ASAAS_DRIVER=asaas\nASAAS_API_KEY={KEY}\n"
        self.assertIn("ASAAS_WEBHOOK_TOKEN vazio", self.joined(base))
        self.assertIn("menos de 32", self.joined(base + f"ASAAS_WEBHOOK_TOKEN={SHORT}\n"))
        self.assertIn("valor de exemplo", self.joined(base + f"ASAAS_WEBHOOK_TOKEN={asa.PLACEHOLDER_TOKEN}\n"))
        self.assertIn("ASAAS_API_KEY vazia", self.joined(f"ASAAS_DRIVER=asaas\nASAAS_WEBHOOK_TOKEN={TOKEN32}\n"))
        self.assertIn("não é https", self.joined(base + f"ASAAS_WEBHOOK_TOKEN={TOKEN32}\nASAAS_API_BASE_URL=http://x\n"))

    def test_complete_config_is_on_without_warning(self):
        out = self.joined(f"ASAAS_DRIVER=asaas\nASAAS_API_KEY={KEY}\nASAAS_WEBHOOK_TOKEN={TOKEN32}\n")
        self.assertIn("Asaas: LIGADO", out)
        self.assertNotIn("AVISO", out)

    def test_validators(self):
        v = asa.VALIDATORS
        self.assertTrue(v["ASAAS_DRIVER"]("") and v["ASAAS_DRIVER"]("asaas"))
        self.assertFalse(v["ASAAS_DRIVER"]("fake"))
        self.assertFalse(v["ASAAS_API_BASE_URL"]("http://x"))
        self.assertTrue(v["ASAAS_API_BASE_URL"]("https://api.asaas.com"))
        self.assertFalse(v["ASAAS_WEBHOOK_TOKEN"](SHORT))
        self.assertTrue(v["ASAAS_WEBHOOK_TOKEN"](TOKEN32))


class UpdateFlow(unittest.TestCase):
    def update(self, text):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        root = make_old_root(tmp.name, text)
        inst, out = installer(root, srv(), update=True, input_fn=no_input, getpass_fn=no_input)
        with DNS_OK:
            code = inst.execute()
        return code, (root / ".env.production").read_text(), "\n".join(out)

    def test_absent_vars_are_added_empty_and_summary_says_off(self):
        code, text, out = self.update(old_env_text())
        self.assertEqual(code, 0)
        values = det.parse_env(text)
        for key in asa.ASAAS_VARS:
            self.assertEqual(values[key], "", key)
        self.assertIn("Asaas: DESLIGADO", out)

    def test_filled_values_are_kept_byte_for_byte_and_no_secret_is_printed(self):
        mine = f"ASAAS_DRIVER=asaas\nASAAS_API_KEY={KEY}\nASAAS_WEBHOOK_TOKEN={SHORT}\n"
        code, text, out = self.update(old_env_text() + mine)
        self.assertEqual(code, 0)
        self.assertIn(mine, text)  # as três linhas, iguais
        self.assertEqual(text.count("ASAAS_DRIVER="), 1)
        self.assertIn("ASAAS_API_BASE_URL=''", text)  # só a ausente entrou
        self.assertIn("ASAAS_WEBHOOK_TOKEN com menos de 32", out)
        for secret in (KEY, SHORT):
            self.assertNotIn(secret, out)

    def test_redaction_covers_values_in_arbitrary_output(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        text = old_env_text() + f"ASAAS_DRIVER=asaas\nASAAS_API_KEY={KEY}\nASAAS_WEBHOOK_TOKEN={TOKEN32}\n"
        inst, out = installer(make_old_root(tmp.name, text), srv(), update=True, input_fn=no_input, getpass_fn=no_input)
        with DNS_OK:
            inst.execute()
        inst.say(f"erro do docker: chave {KEY} token {TOKEN32}")
        joined = "\n".join(out)
        self.assertNotIn(KEY, joined)
        self.assertNotIn(TOKEN32, joined)


if __name__ == "__main__":
    unittest.main()
