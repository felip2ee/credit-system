"""docker-stack.yml: o Docker 20.10 (Debian 11) lê '-' dentro de ${VAR:?msg} como valor padrão."""
import re
import unittest
from pathlib import Path

STACK = Path(__file__).resolve().parents[2] / "docker-stack.yml"


class StackVarMessages(unittest.TestCase):
    def test_required_var_messages_have_no_hyphen(self) -> None:
        bad = re.findall(r"\$\{[A-Za-z_]+:\?[^}]*-[^}]*\}", STACK.read_text(encoding="utf-8"))
        self.assertEqual(bad, [])


if __name__ == "__main__":
    unittest.main()
