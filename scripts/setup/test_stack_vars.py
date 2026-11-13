"""docker-stack.yml: o Docker 20.10 (Debian 11) lê '-' dentro de ${VAR:?msg} como valor padrão."""
import re
import unittest
from pathlib import Path

STACK = Path(__file__).resolve().parents[2] / "docker-stack.yml"


class StackVarMessages(unittest.TestCase):
    def test_required_var_messages_have_no_hyphen(self) -> None:
        bad = re.findall(r"\$\{[A-Za-z_]+:\?[^}]*-[^}]*\}", STACK.read_text(encoding="utf-8"))
        self.assertEqual(bad, [])

    def test_traefik_names_are_unique_and_internal_services_not_exposed(self) -> None:
        text = STACK.read_text(encoding="utf-8")
        # Nomes de router/serviço do Traefik são globais no servidor: 'reino_app' já existe em outra stack.
        self.assertNotIn("routers.reino_app.", text)
        self.assertIn("routers.creditsystem_app.rule=", text)
        # O provider swarm expõe tudo por padrão: os 5 serviços internos precisam de traefik.enable=false.
        self.assertEqual(text.count("traefik.enable=false"), 5)

    def test_pii_key_is_a_secret_not_an_env_var(self) -> None:
        text = STACK.read_text(encoding="utf-8")
        self.assertIn("PII_ENCRYPTION_KEY_FILE: /run/secrets/pii_encryption_key", text)
        self.assertNotRegex(text, r"(?m)^\s+PII_ENCRYPTION_KEY:")
        self.assertIn("pii_encryption_key: { external: true }", text)
        self.assertEqual(text.count("ASAAS_CUSTOMER_ID"), 0)

    def test_asaas_fee_vars_reach_the_app(self) -> None:
        text = STACK.read_text(encoding="utf-8")
        self.assertIn("CARD_FEE_TABLE: ${CARD_FEE_TABLE:-1:2.99:49,6:2.99:49,12:2.99:49}", text)
        self.assertIn("PIX_FEE_CENTS: ${PIX_FEE_CENTS:?", text)

    def test_brand_theme_is_optional_with_atual_default(self):
        self.assertIn("BRAND_THEME: ${BRAND_THEME:-atual}", STACK.read_text(encoding="utf-8"))


if __name__ == "__main__":
    unittest.main()
