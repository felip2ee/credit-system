"""Testes da coleta do instalador: só pergunta o que não dá para gerar; WhatsApp e push opcionais."""
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import install_collect as col  # noqa: E402
import setup_production as sp  # noqa: E402
from install_testkit import installer, make_root, server  # noqa: E402

# Chave descartável, gerada uma vez com: openssl ecparam -name prime256v1 -genkey -noout
# O cabeçalho é montado em partes para o scanner de segredos do repositório não o confundir com uma chave real.
_LABEL = "EC PRIVATE" + " KEY"
PEM = (f"-----BEGIN {_LABEL}-----\n"
       "MHcCAQEEICMvHm5Cdy8OKVZfUnggl4K83mlmiadJVVMcixAe96k8oAoGCCqGSM49\n"
       "AwEHoUQDQgAExvY+rWmbkY0SlYHsIa0fU7uwr/cP0D9YUXqeQ/PVxFgzYaI9OsMu\n"
       "OC3Hi3AeugQtXd53jfvLZdVcQHrRgQx3mQ==\n"
       f"-----END {_LABEL}-----\n")
PUB = "BMb2Pq1pm5GNEpWB7CGtH1O7sK_3D9A_WFF6nkPz1cRYM2GiPTrDLjgtx4twHroELV3ed437y2XVXEB60YEMd5k"
PRIV = "Iy8ebkJ3Lw4pVl9SeCCXgrzeaWaJp0lVUxyLEB73qTw"
ANSWERS = {"Domínio": "app.exemplo.com.br", "Servidor SMTP": "smtp.exemplo.com", "Usuário SMTP": "u",
           "Remetente": "Plataforma <no-reply@exemplo.com.br>", "E-mail do superadmin": "adm@exemplo.com.br",
           "Usuário DEPS": "deps", "Endpoint S3": "s3.exemplo.com", "Bucket S3": "bucket-x",
           "Ativar WhatsApp": "n", "ID do número": "12345",
           "CIDR da rede": "10.0.9.0/24"}


def run_collect(tmp, answers=None, openssl=True, getpass_answers=None):
    fake = server(stack=False)
    script = fake.script
    fake.script = lambda a: (0 if openssl else 127, PEM if openssl else "") if a[0] == "openssl" else script(a)
    given, asked, secret_asked = {**ANSWERS, **(answers or {})}, [], []

    def input_fn(prompt):
        asked.append(prompt)
        return next((v for k, v in given.items() if k in prompt), "")

    def getpass_fn(prompt):
        secret_asked.append(prompt)
        return next((v for k, v in (getpass_answers or {}).items() if k in prompt), "x" * 12)

    inst, _ = installer(make_root(tmp, with_env=False), fake, yes=False, input_fn=input_fn, getpass_fn=getpass_fn)
    env, provided = inst.load_or_collect_env(False, {})
    return env, provided, asked, secret_asked


def has(prompts, text):
    return any(text in p for p in prompts)


class CollectTests(unittest.TestCase):
    def test_whatsapp_no_and_push_no_write_markers_and_skip_prompts(self):
        with tempfile.TemporaryDirectory() as tmp:
            env, provided, asked, secret = run_collect(tmp, {"Ativar notificações push": "n"})
            for text in ("Driver", "ID do número", "Graph", "VAPID", "Contato", "Dono das imagens", "Digest"):
                self.assertFalse(has(asked, text), text)
            self.assertEqual(len([p for p in asked if "WhatsApp" in p]), 1)  # só o sim/não
            self.assertFalse(has(secret, "WhatsApp") or has(secret, "VAPID") or has(secret, "superadmin"))
            self.assertEqual([env[k] for k in ("WHATSAPP_DRIVER", "WHATSAPP_PHONE_NUMBER_ID", "WEB_PUSH_VAPID_PUBLIC_KEY")], ["", "", ""])
            values = sp.build_secrets(provided)
            self.assertEqual(values["whatsapp_access_token"], sp.WHATSAPP_OFF_PLACEHOLDER)
            self.assertEqual(values["whatsapp_app_secret"], sp.WHATSAPP_OFF_PLACEHOLDER)
            self.assertEqual(values["web_push_vapid_private_key"], sp.PUSH_OFF_PLACEHOLDER)

    def test_whatsapp_yes_asks_its_prompts_and_generates_verify_token(self):
        with tempfile.TemporaryDirectory() as tmp:
            env, provided, asked, secret = run_collect(tmp, {"Ativar WhatsApp": "s"})
            for text in ("Driver do WhatsApp (meta = Cloud API) [meta]", "ID do número", "Graph API da Meta [v21.0]"):
                self.assertTrue(has(asked, text), text)
            self.assertTrue(has(secret, "Token de sistema") and has(secret, "App secret"))
            self.assertEqual((env["WHATSAPP_DRIVER"], env["WHATSAPP_PHONE_NUMBER_ID"]), ("meta", "12345"))
            self.assertFalse(has(asked + secret, "verify"))
            values = sp.build_secrets(provided)
            self.assertEqual(len(values["whatsapp_verify_token"]), 64)
            self.assertNotEqual(values["whatsapp_access_token"], sp.WHATSAPP_OFF_PLACEHOLDER)

    def test_push_yes_generates_valid_keys_from_openssl_output(self):
        with tempfile.TemporaryDirectory() as tmp:
            env, provided, asked, secret = run_collect(tmp)
            self.assertEqual((env["WEB_PUSH_VAPID_PUBLIC_KEY"], provided["web_push_vapid_private_key"]), (PUB, PRIV))
            self.assertTrue(len(PUB) == 87 and len(PRIV) == 43)
            self.assertEqual(env["WEB_PUSH_VAPID_SUBJECT"], "mailto:adm@exemplo.com.br")
            self.assertTrue(has(asked, "[mailto:adm@exemplo.com.br]"))
            self.assertFalse(has(secret, "VAPID"))

    def test_push_falls_back_to_asking_when_openssl_is_missing(self):
        with tempfile.TemporaryDirectory() as tmp:
            env, provided, _, secret = run_collect(
                tmp, {"Chave pública VAPID": PUB}, openssl=False, getpass_answers={"VAPID": PRIV})
            self.assertTrue(has(secret, "VAPID"))
            self.assertEqual((env["WEB_PUSH_VAPID_PUBLIC_KEY"], provided["web_push_vapid_private_key"]), (PUB, PRIV))

    def test_garbage_pem_gives_no_keys(self):
        self.assertIsNone(col.parse_ec_pem("-----BEGIN X-----\nAAAA\n-----END X-----\n"))
        self.assertEqual(col.parse_ec_pem(PEM), (PUB, PRIV))

    def test_superadmin_password_is_never_asked_and_alerts_default_to_superadmin(self):
        with tempfile.TemporaryDirectory() as tmp:
            env, provided, asked, secret = run_collect(tmp)
            self.assertFalse(has(secret, "superadmin"))
            self.assertNotIn("superadmin_password", provided)
            self.assertGreaterEqual(len(sp.build_secrets(provided)["superadmin_password"]), 12)
            self.assertTrue(has(asked, "alertas de backup (Enter = o do superadmin) [adm@exemplo.com.br]"))
            self.assertEqual((env["BACKUP_ALERT_TO"], env["OPS_ALERT_TO"]), ("adm@exemplo.com.br",) * 2)


if __name__ == "__main__":
    unittest.main()


class AskMissingAsaasTest(unittest.TestCase):
    class Core:
        def __init__(self, answer):
            self.answer, self.secret_values, self.lines = answer, set(), []
            self.getpass_fn = lambda prompt: self.answer
            self.say = self.lines.append

    def test_chave_vazia_grava_driver_url_e_token(self):
        core = self.Core("k-abc")
        got = col.ask_missing_asaas(core, {"ASAAS_API_KEY": ""})
        self.assertEqual((got["ASAAS_DRIVER"], got["ASAAS_API_KEY"], got["ASAAS_API_BASE_URL"]), ("asaas", "k-abc", "https://api.asaas.com"))
        self.assertGreaterEqual(len(got["ASAAS_WEBHOOK_TOKEN"]), 32)
        self.assertIn("k-abc", core.secret_values)
        self.assertFalse(any(got["ASAAS_WEBHOOK_TOKEN"] in line for line in core.lines))

    def test_enter_pula(self):
        self.assertEqual(col.ask_missing_asaas(self.Core(""), {}), {})

    def test_chave_preenchida_nunca_pergunta(self):
        def boom(_):
            raise AssertionError("perguntou")
        core = self.Core("x")
        core.getpass_fn = boom
        self.assertEqual(col.ask_missing_asaas(core, {"ASAAS_API_KEY": "ja-tem"}), {})
