"""Testes da saída do instalador: linhas ✔/✘ por etapa e bloco de credenciais no terminal."""
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import setup_production as sp  # noqa: E402
from install_testkit import TOKEN, installer, make_root, server  # noqa: E402
from test_install_flow import DNS_OK, PROVIDED, first_input, first_install  # noqa: E402


def run_first(tmp, answer, **kw):
    """Primeira instalação completa; `answer` responde à pergunta de apagar o arquivo."""
    def ask(prompt):
        return answer if "Apagar o arquivo" in prompt else first_input(prompt)
    root, inst, out, collect = first_install(tmp, server(stack=False, secrets=[], traefik=False), input_fn=ask, **kw)
    with collect:
        code = inst.execute()
    return code, "\n".join(out), Path(tmp) / "secure" / "credenciais-T1-GUARDAR.txt"


class OutputTests(unittest.TestCase):
    def test_block_prints_every_secret_and_deletes_file_on_s(self):
        with tempfile.TemporaryDirectory() as tmp, DNS_OK:
            code, text, path = run_first(tmp, "s")
            self.assertEqual(code, 0)
            self.assertIn("CREDENCIAIS DESTA EXECUÇÃO", text)
            for name in sp.SECRET_NAMES:
                self.assertRegex(text, rf"(?m)^{name}=\S+$")
            self.assertIn(f"superadmin_password={PROVIDED['superadmin_password']}", text)
            self.assertNotIn("***", text.split("CREDENCIAIS DESTA EXECUÇÃO")[1].split("FIM DAS CREDENCIAIS")[0])
            self.assertNotIn(TOKEN, text)
            self.assertFalse(path.exists())
            self.assertIn("Arquivo apagado", text)

    def test_file_is_kept_without_s(self):
        with tempfile.TemporaryDirectory() as tmp, DNS_OK:
            _, text, path = run_first(tmp, "")
            self.assertTrue(path.exists())
            self.assertIn("continua em", text)

    def test_yes_keeps_file_and_prints_path(self):
        with tempfile.TemporaryDirectory() as tmp, DNS_OK:
            have = [n for n in sp.SECRET_NAMES if n != "notifications_dispatch_secret"]
            inst, out = installer(make_root(tmp), server(secrets=have))
            self.assertEqual(inst.execute(), 0)
            text = "\n".join(out)
            path = Path(tmp) / "secure" / "credenciais-novos-T1-GUARDAR.txt"
            self.assertTrue(path.exists())
            self.assertIn("notifications_dispatch_secret=", text)
            self.assertIn(f"--yes: o arquivo NÃO foi apagado: {path}", text)

    def test_failed_run_prints_no_secret_value(self):
        with tempfile.TemporaryDirectory() as tmp, DNS_OK:
            root, inst, out, collect = first_install(
                tmp, server(stack=False, secrets=[], traefik=False, migrate="Failed 1 second ago"))
            with collect:
                self.assertEqual(inst.execute(), 1)
            text = "\n".join(out)
            self.assertNotIn("CREDENCIAIS DESTA EXECUÇÃO", text)
            for value in PROVIDED.values():
                self.assertNotIn(value, text)

    def test_other_output_still_redacts(self):
        with tempfile.TemporaryDirectory() as tmp, DNS_OK:
            inst, out = installer(make_root(tmp), server())
            inst.execute()
            inst.say(f"vazou {TOKEN}")
            self.assertNotIn(TOKEN, "\n".join(out))

    def test_every_step_prints_a_check_line(self):
        with tempfile.TemporaryDirectory() as tmp, DNS_OK:
            inst, out = installer(make_root(tmp), server())
            self.assertEqual(inst.execute(), 0)
            lines = [l for l in out if l.startswith("✔ ")]
            for needle in ("Docker:", "Portas 80/443:", "Swarm:", "Traefik: rede RainhaNet", "GHCR:", "Digest ",
                           "DNS:", "Deploy:", "migração", "app (", "health live", "health ready",
                           "certificado TLS", "página de login"):
                self.assertTrue(any(needle in l for l in lines), needle)

    def test_failed_step_prints_cross_line(self):
        with tempfile.TemporaryDirectory() as tmp, DNS_OK:
            inst, out = installer(make_root(tmp), server(migrate="Failed 1 second ago"))
            self.assertEqual(inst.execute(), 1)
            self.assertTrue(any(l.startswith("✘ migração") for l in out))


if __name__ == "__main__":
    unittest.main()
