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


if __name__ == "__main__":
    unittest.main()
