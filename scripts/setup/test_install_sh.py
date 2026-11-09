"""install.sh: validação do CS_REF via `--check-ref` (sai antes de rede, root e Linux)."""
import os
import subprocess
import unittest
from pathlib import Path

SH = Path(__file__).resolve().parent / "install.sh"
SHA = "0123456789abcdef0123456789abcdef01234567"


def check(ref, *flags):
    env = {"PATH": os.environ["PATH"], "CS_REF": ref}
    result = subprocess.run(["bash", str(SH), "--check-ref", *flags], capture_output=True, text=True, env=env)
    return result.returncode, result.stdout + result.stderr


class RefValidationTests(unittest.TestCase):
    def test_accepts_full_sha_and_tag_ref(self):
        for ref in (SHA, "refs/tags/v1.0.0", "refs/tags/release-2026.1"):
            self.assertEqual(check(ref)[0], 0, ref)

    def test_latest_main_and_empty_ref_only_with_update(self):
        self.assertEqual(check("latest-main", "--update")[0], 0)
        self.assertEqual(check("", "--update")[0], 0)
        code, out = check("latest-main")
        self.assertEqual(code, 1)
        self.assertIn("só vale com --update", out)
        self.assertEqual(check("")[0], 1)

    def test_rejects_branches_and_other_refs(self):
        bad = ("develop", "main", "master", "HEAD", "feature/x", "refs/heads/main", "refs/heads/feature/x", "origin/main",
               "refs/pull/12/head", "v1.0.0", "refs/tags/", "refs/tags/a..b", "refs/tags/a/b", "-x", SHA[:39], SHA.upper(),
               SHA + "0", "refs/tags/v1;rm", "refs/tags/v1 x")
        for ref in bad:
            code, out = check(ref)
            self.assertEqual(code, 1, ref)
            self.assertIn("ERRO", out)
        self.assertEqual(check("refs/heads/main", "--update")[0], 1)  # --update não afrouxa a regra

    def test_unknown_option_is_refused(self):
        self.assertEqual(check(SHA, "--force")[0], 1)


if __name__ == "__main__":
    unittest.main()
