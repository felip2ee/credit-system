"""Variáveis ASAAS_*: na stack, adicionadas vazias no --update, valores preenchidos intactos, resumo sem segredos."""
import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent))

import install as ins  # noqa: E402
import install_asaas as asa  # noqa: E402
import install_detect as det  # noqa: E402
import setup_production as sp  # noqa: E402
from install_testkit import installer, server  # noqa: E402
from test_install_flow import PROVIDED, first_input  # noqa: E402
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


def with_running_env(fake, items, code=0):
    """Responde ao `docker service inspect ... Env` do app; o resto segue o servidor simulado."""
    script = fake.script

    def wrapped(a):
        if a[:3] == ["docker", "service", "inspect"] and "ContainerSpec.Env" in a[-1]:
            return code, json.dumps(items) if code == 0 else "erro"
        return script(a)
    fake.script = wrapped
    return fake


class ParseEnv(unittest.TestCase):
    def test_export_prefix_is_read_and_normal_lines_are_unchanged(self):
        text = "# c\n\nexport A=1\nB='x y'\nC=\nD=\"q\"\n  E=5\nexport\tF=6\n"
        self.assertEqual(det.parse_env(text), {"A": "1", "B": "x y", "C": "", "D": "q", "E": "5", "F": "6"})

    def test_unreadable_line_stops_with_line_number_and_never_prints_the_value(self):
        with self.assertRaises(det.Stop) as ctx:
            det.parse_env(f"A=1\n\nASAAS_API_KEY='{KEY}\n")
        self.assertIn("ASAAS_API_KEY: linha ilegível em .env.production: 3", str(ctx.exception))
        self.assertNotIn(KEY, str(ctx.exception))

    def test_set_env_value_keeps_export_prefix_and_does_not_duplicate(self):
        out = det.set_env_value("export A=1\n  B=2\n", "A", "9")
        self.assertEqual(det.set_env_value(out, "B", "8"), "export A=9\n  B=8\n")


class FirstInstall(unittest.TestCase):
    def run_first(self, answers):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        asked = []

        def input_fn(prompt):
            asked.append(prompt)
            return answers.get("driver", "") if "Asaas ligado" in prompt else first_input(prompt)

        def getpass_fn(prompt):
            return KEY if "Chave de API do Asaas" in prompt else TOKEN32

        root = Path(tmp.name)
        run = server(stack=False, secrets=[], traefik=False)
        (root / "docker-stack.yml").write_text("services: {}\n")
        inst, out = installer(root, run, yes=False, input_fn=input_fn, getpass_fn=getpass_fn)
        base = {k: "" for k in sp.ENV_KEYS} | {"APP_DOMAIN": "app.exemplo.com.br", "SUPERADMIN_EMAIL": "a@b.co"}
        with mock.patch.object(sp, "collect", return_value=(base, dict(PROVIDED))), DNS_OK:
            inst.execute()
        return root, inst, "\n".join(out)

    def test_asaas_answers_are_written_to_env_and_never_echoed_or_put_in_credentials(self):
        root, inst, out = self.run_first({"driver": "asaas"})
        values = det.parse_env((root / ".env.production").read_text())
        self.assertEqual((values["ASAAS_DRIVER"], values["ASAAS_API_KEY"], values["ASAAS_WEBHOOK_TOKEN"]),
                         ("asaas", KEY, TOKEN32))
        self.assertEqual(values["ASAAS_API_BASE_URL"], asa.DEFAULT_URL)
        for secret in (KEY, TOKEN32):
            self.assertNotIn(secret, out)
            self.assertNotIn(secret, (root / "secure" / "credenciais-T1-GUARDAR.txt").read_text())

    def test_empty_answer_keeps_asaas_off(self):
        root, _, out = self.run_first({})
        values = det.parse_env((root / ".env.production").read_text())
        self.assertEqual([values[k] for k in asa.ASAAS_VARS], ["", "", "", ""])


class UpdateKeepsMyLines(unittest.TestCase):
    def test_export_and_quoted_lines_are_kept_byte_for_byte_without_duplicates(self):
        mine = f"export ASAAS_DRIVER=asaas\nASAAS_API_KEY='$aact_x'\n"
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        root = make_old_root(tmp.name, old_env_text() + mine)
        run = srv()
        inst, _ = installer(root, run, update=True, input_fn=no_input, getpass_fn=no_input)
        with DNS_OK:
            self.assertEqual(inst.execute(), 0)
        text = (root / ".env.production").read_text()
        self.assertIn(mine, text)
        self.assertEqual(text.count("ASAAS_DRIVER="), 1)
        self.assertEqual(text.count("ASAAS_API_KEY="), 1)
        deployed = run.ran("docker", "stack", "deploy")[0][2]
        self.assertEqual((deployed["ASAAS_DRIVER"], deployed["ASAAS_API_KEY"]), ("asaas", "$aact_x"))


class RunningEnvGuard(unittest.TestCase):
    RUNNING = [f"ASAAS_DRIVER=asaas", f"ASAAS_API_KEY={KEY}", "ASAAS_API_BASE_URL=https://api.asaas.com", "PATH=/bin"]

    def update(self, text, running=None, code=0, **kw):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        run = with_running_env(srv(), self.RUNNING if running is None else running, code)
        inst, out = installer(make_old_root(tmp.name, text), run, update=True, input_fn=lambda p: "n",
                              getpass_fn=(no_input if kw.get("yes", True) else (lambda prompt: "")), **kw)
        try:
            with DNS_OK:
                result = inst.execute()
        except ins.Stop as exc:
            result = exc
        return result, run, "\n".join(out)

    def test_yes_stops_when_deploy_would_blank_a_running_value_and_prints_only_names(self):
        result, run, out = self.update(old_env_text())
        self.assertIsInstance(result, ins.Stop)
        self.assertIn("ASAAS_DRIVER, ASAAS_API_KEY", str(result))
        self.assertIn("ESVAZIAR", out)
        self.assertNotIn(KEY, out)
        self.assertEqual(run.ran("docker", "stack", "deploy"), [])

    def test_interactive_default_is_no(self):
        result, run, out = self.update(old_env_text(), yes=False)
        self.assertIsInstance(result, ins.Stop)
        self.assertEqual(run.ran("docker", "stack", "deploy"), [])

    def test_same_values_no_warning(self):
        mine = f"ASAAS_DRIVER=asaas\nASAAS_API_KEY={KEY}\n"
        result, run, out = self.update(old_env_text() + mine)
        self.assertEqual(result, 0)
        self.assertNotIn("ESVAZIAR", out)

    def test_docker_failure_skips_with_note(self):
        result, _, out = self.update(old_env_text(), code=1)
        self.assertEqual(result, 0)
        self.assertIn("pulei a conferência das variáveis ASAAS_*", out)


if __name__ == "__main__":
    unittest.main()
