"""Testes da atualização rápida: detecção, reconciliação do .env, secret PII, --yes, rollback e idempotência."""
import os
import re
import stat
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent))

import install as ins  # noqa: E402
import install_detect as det  # noqa: E402
import install_update as upd  # noqa: E402
import setup_production as sp  # noqa: E402
from install_testkit import NEW, OLD, TOKEN, Fake, env_values, installer, server  # noqa: E402

DNS_OK = mock.patch.object(det.socket, "gethostbyname_ex", return_value=("h", [], ["203.0.113.9"]))
HEAD = "f" * 40
DEPLOYED = "1" * 40
NEW_KEYS = ("PIX_FEE_CENTS", "CARD_FEE_TABLE", "CARD_MIN_INSTALLMENT_CENTS", "ASAAS_DRIVER", "ASAAS_API_BASE_URL",
            "ASAAS_API_KEY", "ASAAS_WEBHOOK_TOKEN")
FULL = dict(SMTP_HOST="smtp.exemplo.com", SUPERADMIN_EMAIL="a@exemplo.com", RESTIC_S3_ENDPOINT="s3.exemplo.com",
            RESTIC_S3_BUCKET="bucket-reino", SMTP_USER="u", CARD_FEE_TABLE="")


def old_env_text(**extra):
    """.env.production de uma instalação anterior ao PR #89: sem as três variáveis novas."""
    values = env_values(**FULL, **extra)
    lines = [l for l in sp.render_env(values).splitlines() if l.split("=", 1)[0] not in NEW_KEYS]
    return "\n".join(lines) + "\nLGPD_PURGE_ENABLED=1\n"


def make_old_root(tmp, text=None):
    root = Path(tmp)
    (root / "docker-stack.yml").write_text("services: {}\n")
    (root / "db" / "migrations").mkdir(parents=True)
    for name in ("039_a.sql", "045_b.sql"):
        (root / "db" / "migrations" / name).write_text("select 1;\n")
    (root / ".env.production").write_text(old_env_text() if text is None else text)
    return root


OLD_STACK = "services: {antigo: {}}\n"


def srv(diff="db/migrations/040_x.sql\ndb/migrations/045_b.sql\n", old_stack=OLD_STACK, on_deploy=None, **kw):
    base = server(**kw)

    def script(a):
        if a[0] == "git" and "rev-parse" in a:
            return 0, HEAD + "\n"
        if a[0] == "git" and "diff" in a:
            return 0, diff
        if a[0] == "git" and "show" in a:
            return (0, old_stack) if old_stack is not None else (128, "fatal: invalid object name")
        if a[:3] == ["docker", "stack", "deploy"] and on_deploy:
            on_deploy(a)
        return base.script(a)
    return Fake(script)


def changes(run):
    """Mudanças no servidor (login/pull/logout do registry ficam de fora)."""
    return [m for m in run.mutations() if m[:2] not in (["docker", "login"], ["docker", "logout"], ["docker", "pull"])]


def no_input(prompt):
    raise AssertionError(f"perguntou: {prompt}")


class PlanEnvTests(unittest.TestCase):
    def test_missing_empty_pix_and_invalid_are_classified_and_filled_values_are_kept(self):
        plan = upd.plan_env("APP_DOMAIN=a.b.co\nPIX_FEE_CENTS=\nCARD_MIN_INSTALLMENT_CENTS=abc\n")
        self.assertEqual((plan.added, plan.filled, plan.invalid), (["CARD_FEE_TABLE"], ["PIX_FEE_CENTS"], ["CARD_MIN_INSTALLMENT_CENTS"]))
        ok = upd.plan_env("PIX_FEE_CENTS=0\nCARD_FEE_TABLE=\nCARD_MIN_INSTALLMENT_CENTS=700\n")
        self.assertEqual((ok.added, ok.filled, ok.invalid), ([], [], []))  # vazio em CARD_FEE_TABLE = cartão desligado

    def test_card_table_validator(self):
        valid = upd.VALIDATORS["CARD_FEE_TABLE"]
        self.assertTrue(valid(upd.NEW_VARS["CARD_FEE_TABLE"]))
        self.assertFalse(valid("1:2.99"))
        self.assertFalse(valid("x"))
        self.assertFalse(valid("1:2.99:49\n"))  # fullmatch: `$` aceitaria "\n" no fim
        self.assertFalse(valid("١:2.99:49"))  # dígito não ASCII
        self.assertFalse(upd.VALIDATORS["PIX_FEE_CENTS"]("١٢٣"))
        self.assertFalse(upd.VALIDATORS["CARD_MIN_INSTALLMENT_CENTS"]("٥٠٠"))

    def test_present_line_that_fails_to_parse_stops_with_line_number(self):
        with self.assertRaisesRegex(ins.Stop, "PIX_FEE_CENTS: linha ilegível em .env.production: 1"):
            upd.plan_env("PIX_FEE_CENTS='199\nCARD_FEE_TABLE=\n")

    def test_set_env_value_keeps_crlf(self):
        text = det.set_env_value("A=1\r\nB=2\r\n", "B", "3")
        self.assertEqual(det.set_env_value(text, "C", "4"), "A=1\r\nB=3\r\nC=4\r\n")

    def test_brand_theme_is_optional_and_update_keeps_the_operator_value(self):
        self.assertNotIn("BRAND_THEME", upd.REQUIRED_ENV)
        self.assertNotIn("BRAND_THEME", upd.NEW_VARS)
        text = "APP_DOMAIN=a.b.co\nBRAND_THEME=classico\nPIX_FEE_CENTS=199\n"
        plan = upd.plan_env(text)
        self.assertNotIn("BRAND_THEME", plan.added + plan.filled + plan.invalid)
        self.assertEqual(upd.missing_required(text), ["REINO_IMAGE_OWNER", "SMTP_HOST", "SUPERADMIN_EMAIL", "RESTIC_S3_ENDPOINT", "RESTIC_S3_BUCKET"])
        self.assertIn("BRAND_THEME=classico\n", upd.apply_values(text, {"CARD_FEE_TABLE": "1:2.99:49"}))
        self.assertEqual(upd.missing_required("APP_DOMAIN=a.b.co\n"), upd.missing_required(text))  # sem BRAND_THEME não muda nada

    def test_apply_values_only_touches_given_keys(self):
        text = upd.apply_values("A=1\nPIX_FEE_CENTS=\n", {"PIX_FEE_CENTS": "199", "CARD_FEE_TABLE": "1:2.99:49,6:2.99:49"})
        self.assertEqual(text, "A=1\nPIX_FEE_CENTS=199\nCARD_FEE_TABLE=1:2.99:49,6:2.99:49\n")

    def test_migrations_note_uses_file_diff_or_admits_unknown(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = make_old_root(tmp)
            run = srv()
            text, pending = upd.migrations_note(run, root, DEPLOYED)
            self.assertIn("2 migration(s) nova(s), de 040_x.sql até 045_b.sql", text)
            self.assertTrue(pending)
            text, pending = upd.migrations_note(run, root, "")
            self.assertTrue(pending)  # versão desconhecida: pode haver migration
            self.assertIn("não sei qual versão", text)
            self.assertIn("045_b.sql", text)
            self.assertEqual(upd.migrations_note(srv(diff=""), root, DEPLOYED)[1], False)


class UpdateFlowTests(unittest.TestCase):
    def update_installer(self, tmp, run, text=None, **kw):
        kw.setdefault("yes", True)
        return installer(make_old_root(tmp, text), run, **kw)

    def test_existing_complete_install_is_detected_and_offered_one_confirm(self):
        prompts = []

        def answer(prompt):
            prompts.append(prompt)
            return "s" if "Aplicar" in prompt else ""  # oferta: Enter = [S/n] sim; migrations: exige digitar 's'

        with tempfile.TemporaryDirectory() as tmp, DNS_OK:
            run = srv()
            inst, out = self.update_installer(tmp, run, yes=False, confirm_backup=False, input_fn=answer, getpass_fn=lambda prompt: "")
            self.assertEqual(inst.execute(), 0)
            self.assertEqual(len(prompts), 2, prompts)  # oferta + confirma do resumo, nada mais
            self.assertTrue(any("reaproveitando tudo" in p for p in prompts))
            self.assertTrue(any("Aplicar a atualização" in p for p in prompts))
            self.assertIn("Resumo da atualização", "\n".join(out))
            self.assertTrue(inst.update)

    def test_declining_the_offer_stops_before_any_change(self):
        with tempfile.TemporaryDirectory() as tmp:
            run = srv()
            inst, _ = self.update_installer(tmp, run, yes=False, input_fn=lambda p: "n")
            with self.assertRaisesRegex(ins.Stop, "Cancelado"):
                inst.execute()
            self.assertEqual(run.mutations(), [])

    def test_incomplete_env_is_not_offered_and_update_flag_refuses_it(self):
        with tempfile.TemporaryDirectory() as tmp:
            inst, _ = self.update_installer(tmp, srv(), text="APP_DOMAIN=a.b.co\n", update=True)
            with self.assertRaisesRegex(ins.Stop, "completo"):
                inst.execute()
        with tempfile.TemporaryDirectory() as tmp:
            inst, _ = self.update_installer(tmp, srv(stack=False), update=True)
            with self.assertRaisesRegex(ins.Stop, "--update exige a stack"):
                inst.execute()

    def test_adds_missing_vars_keeps_filled_and_deploys_with_them(self):
        with tempfile.TemporaryDirectory() as tmp, DNS_OK:
            run = srv()
            inst, out = self.update_installer(tmp, run, update=True, input_fn=no_input, getpass_fn=no_input)
            self.assertEqual(inst.execute(), 0)
            text = (Path(tmp) / ".env.production").read_text()
            self.assertEqual(det.parse_env(text)["PIX_FEE_CENTS"], "199")
            self.assertEqual(det.parse_env(text)["CARD_FEE_TABLE"], "1:2.99:49,6:2.99:49,12:2.99:49")
            self.assertEqual(det.parse_env(text)["CARD_MIN_INSTALLMENT_CENTS"], "500")
            self.assertEqual(det.parse_env(text)["SMTP_HOST"], "smtp.exemplo.com")
            self.assertIn("LGPD_PURGE_ENABLED=1", text)
            self.assertEqual(det.parse_env(text)["CS_DEPLOYED_SHA"], HEAD)
            sent = run.ran("docker", "stack", "deploy")[0][2]
            self.assertEqual((sent["PIX_FEE_CENTS"], sent["REINO_IMAGE_DIGEST"]), ("199", NEW))

    def test_empty_pix_fee_is_filled_with_warning_and_filled_card_vars_are_kept(self):
        text = old_env_text() + "PIX_FEE_CENTS=\nCARD_FEE_TABLE=1:3.5:50\nCARD_MIN_INSTALLMENT_CENTS=700\n"
        with tempfile.TemporaryDirectory() as tmp, DNS_OK:
            inst, out = self.update_installer(tmp, srv(), text=text, update=True, input_fn=no_input)
            self.assertEqual(inst.execute(), 0)
            values = det.parse_env((Path(tmp) / ".env.production").read_text())
            self.assertEqual((values["PIX_FEE_CENTS"], values["CARD_FEE_TABLE"], values["CARD_MIN_INSTALLMENT_CENTS"]),
                             ("199", "1:3.5:50", "700"))
            self.assertIn("PIX_FEE_CENTS estava vazia", "\n".join(out))

    def test_invalid_value_is_asked_and_never_guessed_with_yes(self):
        text = old_env_text() + "PIX_FEE_CENTS=um real\n"
        with tempfile.TemporaryDirectory() as tmp, DNS_OK:
            run = srv()
            inst, _ = self.update_installer(tmp, run, text=text, update=True)
            with self.assertRaisesRegex(ins.Stop, "PIX_FEE_CENTS.*inválida"):
                inst.execute()
            self.assertEqual(changes(run), [])
        with tempfile.TemporaryDirectory() as tmp, DNS_OK:
            inst, _ = self.update_installer(tmp, srv(), text=text, update=True, yes=False,
                                            input_fn=lambda p: "249" if "Pix" in p else "s" if "Aplicar" in p else "")
            self.assertEqual(inst.execute(), 0)
            self.assertEqual(det.parse_env((Path(tmp) / ".env.production").read_text())["PIX_FEE_CENTS"], "249")

    def test_pii_secret_created_only_when_missing_and_saved_in_new_file(self):
        have = [n for n in sp.SECRET_NAMES if n != "pii_encryption_key"]
        with tempfile.TemporaryDirectory() as tmp, DNS_OK:
            run = srv(secrets=have)
            inst, out = self.update_installer(tmp, run, update=True, input_fn=no_input)
            self.assertEqual(inst.execute(), 0)
            self.assertEqual([c[0][3] for c in run.ran("docker", "secret", "create")], ["pii_encryption_key"])
            saved = Path(tmp) / "secure" / "credenciais-novos-T1-GUARDAR.txt"
            self.assertRegex(saved.read_text(), r"^pii_encryption_key=k1:[A-Za-z0-9+/]{43}=\n$")
            self.assertIn("CREDENCIAIS DESTA EXECUÇÃO", "\n".join(out))
            self.assertIn("pii_encryption_key=k1:", "\n".join(out))
            self.assertTrue(saved.exists())  # --yes não apaga
        with tempfile.TemporaryDirectory() as tmp, DNS_OK:
            run = srv()
            inst, _ = self.update_installer(tmp, run, update=True, input_fn=no_input)
            inst.execute()
            self.assertEqual(run.ran("docker", "secret", "create"), [])
            self.assertFalse((Path(tmp) / "secure").exists())

    def test_failed_update_prints_no_secret_and_rolls_back_with_new_vars(self):
        have = [n for n in sp.SECRET_NAMES if n != "pii_encryption_key"]
        with tempfile.TemporaryDirectory() as tmp, DNS_OK:
            before = old_env_text()
            run = srv(secrets=have, tasks_state="Failed 1 second ago")
            inst, out = self.update_installer(tmp, run, text=before, update=True, input_fn=no_input)
            self.assertEqual(inst.execute(), 1)
            text = "\n".join(out)
            self.assertNotIn("k1:", text)
            self.assertNotIn("CREDENCIAIS DESTA EXECUÇÃO", text)
            self.assertIn("NÃO foram impressos", text)
            deploys = run.ran("docker", "stack", "deploy")
            self.assertEqual([d[2]["REINO_IMAGE_DIGEST"] for d in deploys], [NEW, OLD])
            self.assertEqual(deploys[1][2]["PIX_FEE_CENTS"], "199")  # a stack nova exige a variável também no rollback
            self.assertEqual((Path(tmp) / ".env.production").read_text(), before)

    def test_image_not_published_stops_before_creating_anything(self):
        have = [n for n in sp.SECRET_NAMES if n != "pii_encryption_key"]
        with tempfile.TemporaryDirectory() as tmp, DNS_OK:
            run = srv(secrets=have, buildx=False, fail=lambda a: a[:2] == ["docker", "pull"])
            inst, _ = self.update_installer(tmp, run, update=True, input_fn=no_input)
            with self.assertRaisesRegex(ins.Stop, "ainda não foi publicada"):
                inst.execute()
            self.assertEqual(changes(run), [])
            self.assertEqual((Path(tmp) / ".env.production").read_text(), old_env_text())

    def test_summary_lists_secret_vars_and_migrations_before_applying(self):
        have = [n for n in sp.SECRET_NAMES if n != "pii_encryption_key"]
        with tempfile.TemporaryDirectory() as tmp, DNS_OK:
            text = old_env_text() + f"CS_DEPLOYED_SHA={DEPLOYED}\n"
            run = srv(secrets=have)
            inst, out = self.update_installer(tmp, run, text=text, update=True, input_fn=no_input)
            inst.execute()
            joined = "\n".join(out)
            self.assertIn("secrets a criar: pii_encryption_key", joined)
            self.assertIn("adicionar PIX_FEE_CENTS=199, CARD_FEE_TABLE=1:2.99:49,6:2.99:49,12:2.99:49, CARD_MIN_INSTALLMENT_CENTS=500", joined)
            self.assertIn("de 040_x.sql até 045_b.sql", joined)
            self.assertIn(f"commit {HEAD[:12]}", joined)
            self.assertIn("cartão: será LIGADO (CARD_FEE_TABLE=1:2.99:49,6:2.99:49,12:2.99:49)", joined)
            self.assertLess(joined.index("Resumo da atualização"), joined.index("criando 1 secret"))

    def test_second_run_changes_nothing(self):
        with tempfile.TemporaryDirectory() as tmp, DNS_OK:
            root = make_old_root(tmp)
            installer(root, srv(), update=True, input_fn=no_input)[0].execute()
            first = (root / ".env.production").read_text()
            run = srv(current=NEW)
            inst, out = installer(root, run, update=True, input_fn=no_input)
            self.assertEqual(inst.execute(), 0)
            self.assertEqual((root / ".env.production").read_text(), first)
            self.assertEqual(run.ran("docker", "secret", "create"), [])
            self.assertEqual(inst.reconciled, {})
            self.assertIn("sem variáveis novas", "\n".join(out))
            self.assertNotIn("rollback", "\n".join(out).lower())

    def test_dry_run_changes_nothing_and_does_not_ask(self):
        with tempfile.TemporaryDirectory() as tmp, DNS_OK:
            run = srv()
            inst, out = self.update_installer(tmp, run, yes=False, dry_run=True, update=True, input_fn=no_input)
            self.assertEqual(inst.execute(), 0)
            self.assertEqual(run.mutations(), [])
            self.assertEqual((Path(tmp) / ".env.production").read_text(), old_env_text())
            self.assertIn("Resumo da atualização", "\n".join(out))


class RollbackTests(unittest.TestCase):
    """P1-1, P1-2, P1-3: rollback com o stack antigo, sem abortar no login, e versão atual sempre conhecida."""

    def failing(self, tmp, text, logins_ok=1, deploys_ok=2, **kw):
        """Servidor em que o app novo falha; login e deploy passam `*_ok` vezes e depois falham."""
        count = {"login": 0, "deploy": 0}
        stacks = []

        def fail(a):
            for key, ok in (("login", logins_ok), ("deploy", deploys_ok)):
                if a[:2 if key == "login" else 3] == (["docker", "login"] if key == "login" else ["docker", "stack", "deploy"]):
                    count[key] += 1
                    return count[key] > ok
            return False

        def on_deploy(a):
            path = Path(a[a.index("-c") + 1])
            stacks.append((path, path.read_text(), stat.S_IMODE(path.stat().st_mode)))

        run = srv(secrets=sp.SECRET_NAMES, tasks_state="Failed 1 second ago", fail=fail, on_deploy=on_deploy, **kw)
        root = make_old_root(tmp, text)
        inst, out = installer(root, run, update=True, input_fn=no_input)
        return run, inst, out, stacks

    def test_rollback_uses_stack_file_of_deployed_commit_in_temp_0600_file(self):
        with tempfile.TemporaryDirectory() as tmp, DNS_OK:
            run, inst, out, stacks = self.failing(tmp, old_env_text() + f"CS_DEPLOYED_SHA={DEPLOYED}\n")
            self.assertEqual(inst.execute(), 1)
            self.assertEqual(stacks[0][1], "services: {}\n")  # deploy novo: stack atual
            path, content, mode = stacks[1]
            self.assertEqual((content, mode), (OLD_STACK, 0o600))  # rollback: stack do commit antigo
            self.assertFalse(path.exists())  # temporário removido
            show = run.ran("git", "-C", str(Path(tmp)), "show")[0][0]
            self.assertEqual(show[-1], f"{DEPLOYED}:docker-stack.yml")
            self.assertEqual(run.ran("docker", "stack", "deploy")[1][2]["PIX_FEE_CENTS"], "199")
            self.assertIn("Rollback concluído", "\n".join(out))

    def test_unknown_deployed_sha_warns_and_falls_back_to_current_stack(self):
        with tempfile.TemporaryDirectory() as tmp, DNS_OK:
            run, inst, out, stacks = self.failing(tmp, old_env_text())
            self.assertEqual(inst.execute(), 1)
            self.assertEqual(stacks[1][1], "services: {}\n")
            self.assertIn("CS_DEPLOYED_SHA é desconhecido", "\n".join(out))
            self.assertEqual(run.ran("git", "-C", str(Path(tmp)), "show"), [])

    def test_unreadable_old_stack_in_git_falls_back_with_warning(self):
        with tempfile.TemporaryDirectory() as tmp, DNS_OK:
            run, inst, out, stacks = self.failing(tmp, old_env_text() + f"CS_DEPLOYED_SHA={DEPLOYED}\n", old_stack=None)
            self.assertEqual(inst.execute(), 1)
            self.assertEqual(stacks[1][1], "services: {}\n")
            self.assertIn("não achei docker-stack.yml no commit", "\n".join(out))

    def test_rollback_login_failure_still_tries_the_deploy(self):
        with tempfile.TemporaryDirectory() as tmp, DNS_OK:
            run, inst, out, _ = self.failing(tmp, old_env_text(), logins_ok=1)
            self.assertEqual(inst.execute(), 1)
            self.assertEqual(len(run.ran("docker", "login")), 2)  # 2º login (do rollback) falhou
            self.assertEqual(len(run.ran("docker", "stack", "deploy")), 2)  # e o deploy do rollback rodou
            text = "\n".join(out)
            self.assertIn("Tento o deploy do rollback mesmo assim", text)
            self.assertIn("Rollback concluído", text)
            self.assertNotIn(TOKEN, text)

    def test_rollback_not_applied_says_so_with_manual_command(self):
        with tempfile.TemporaryDirectory() as tmp, DNS_OK:
            before = old_env_text() + f"CS_DEPLOYED_SHA={DEPLOYED}\n"
            run, inst, out, _ = self.failing(tmp, before, logins_ok=1, deploys_ok=1)
            self.assertEqual(inst.execute(), 1)
            text = "\n".join(out)
            self.assertIn(f"ROLLBACK NÃO APLICADO: produção está na versão nova sha256:{NEW}", text)
            self.assertIn("docker stack deploy --with-registry-auth -c /root/docker-stack-anterior.yml reino", text)
            self.assertIn(f"show {DEPLOYED}:docker-stack.yml", text)
            self.assertIn("export PIX_FEE_CENTS=199", text)
            self.assertNotIn("Rollback concluído", text)
            self.assertEqual((Path(tmp) / ".env.production").read_text(), before)
            self.assertTrue(run.ran("docker", "logout"))

    def test_current_version_falls_back_to_env_digest_then_stops_before_any_change(self):
        no_image = lambda a: a[:3] == ["docker", "service", "inspect"] and "ContainerSpec.Image" in a[-1]
        with tempfile.TemporaryDirectory() as tmp, DNS_OK:
            run = srv(fail=no_image)
            inst, out = installer(make_old_root(tmp), run, update=True, input_fn=no_input)
            self.assertEqual(inst.execute(), 0)  # env_values() traz REINO_IMAGE_DIGEST=OLD
            self.assertIn("uso REINO_IMAGE_DIGEST do .env.production", "\n".join(out))
            self.assertIn(f"sha256:{OLD[:12]}", "\n".join(out))
        with tempfile.TemporaryDirectory() as tmp, DNS_OK:
            text = "\n".join(l for l in old_env_text().splitlines() if not l.startswith("REINO_IMAGE_DIGEST="))
            run = srv(fail=no_image, secrets=[n for n in sp.SECRET_NAMES if n != "pii_encryption_key"])
            inst, out = installer(make_old_root(tmp, text), run, update=True, input_fn=no_input)
            with self.assertRaisesRegex(ins.Stop, "descobrir a versão atual"):
                inst.execute()
            self.assertEqual(changes(run), [])
            self.assertNotIn("primeira instalação", "\n".join(out).lower().replace("modo: atualização", ""))


class NewSecretValueTests(unittest.TestCase):
    """P1-4: o valor vai para o arquivo ANTES de existir no Docker."""
    HAVE = [n for n in sp.SECRET_NAMES if n != "pii_encryption_key"]

    def test_file_is_written_before_the_first_secret_create(self):
        seen = []

        def fail(a):
            if a[:3] == ["docker", "secret", "create"]:
                files = list((Path(tmp) / "secure").glob("credenciais-novos-*"))
                seen.append(files[0].read_text() if files else None)
            return False

        with tempfile.TemporaryDirectory() as tmp, DNS_OK:
            inst, _ = installer(make_old_root(tmp), srv(secrets=self.HAVE, fail=fail), update=True, input_fn=no_input)
            self.assertEqual(inst.execute(), 0)
        self.assertRegex(seen[0], r"^pii_encryption_key=k1:")

    def test_write_failure_creates_no_secret_and_leaks_nothing(self):
        with tempfile.TemporaryDirectory() as tmp, DNS_OK, \
                mock.patch.object(sp, "_write_private", side_effect=OSError("disco cheio")):
            run = srv(secrets=self.HAVE)
            inst, out = installer(make_old_root(tmp), run, update=True, input_fn=no_input)
            with self.assertRaisesRegex(ins.Stop, "Nenhum secret foi criado"):
                inst.execute()
            self.assertEqual(run.ran("docker", "secret", "create"), [])
            self.assertNotIn("k1:", "\n".join(out))
            self.assertEqual(list((Path(tmp) / "secure").glob("credenciais*")), [])

    def test_create_failure_undoes_secrets_and_removes_file_without_printing_values(self):
        two = ("pii_encryption_key", "notifications_dispatch_secret")
        order = [n for n in sp.SECRET_NAMES if n in two]
        have = [n for n in sp.SECRET_NAMES if n not in two]
        fail = lambda a: a[:3] == ["docker", "secret", "create"] and a[3] == order[1]
        with tempfile.TemporaryDirectory() as tmp, DNS_OK:
            run = srv(secrets=have, fail=fail)
            inst, out = installer(make_old_root(tmp), run, update=True, input_fn=no_input)
            with self.assertRaisesRegex(ins.Stop, "Desfiz"):
                inst.execute()
            self.assertEqual([c[0][3] for c in run.ran("docker", "secret", "rm")], [order[0]])
            self.assertEqual(list((Path(tmp) / "secure").glob("credenciais*")), [])
            self.assertNotIn("k1:", "\n".join(out))

    def test_stuck_secret_keeps_the_file_with_its_value(self):
        two = ("pii_encryption_key", "notifications_dispatch_secret")
        order = [n for n in sp.SECRET_NAMES if n in two]
        have = [n for n in sp.SECRET_NAMES if n not in two]
        fail = lambda a: (a[:3] == ["docker", "secret", "create"] and a[3] == order[1]) or a[:3] == ["docker", "secret", "rm"]
        with tempfile.TemporaryDirectory() as tmp, DNS_OK:
            inst, out = installer(make_old_root(tmp), srv(secrets=have, fail=fail), update=True, input_fn=no_input)
            with self.assertRaises(ins.Stop):
                inst.execute()
            kept = list((Path(tmp) / "secure").glob("credenciais-novos-*"))
            self.assertEqual(len(kept), 1)
            self.assertIn(f"{order[0]}=", kept[0].read_text())
            self.assertIn("ficaram (não impressos)", "\n".join(out))
            self.assertNotIn("k1:", "\n".join(out))


class MigrationSafeguardTests(unittest.TestCase):
    """P1-5: --yes e Enter não aplicam migrations irreversíveis sem backup afirmado."""

    def test_yes_with_migrations_stops_without_backup_flag_and_changes_nothing(self):
        with tempfile.TemporaryDirectory() as tmp, DNS_OK:
            run = srv()
            inst, out = installer(make_old_root(tmp), run, update=True, confirm_backup=False, input_fn=no_input)
            with self.assertRaisesRegex(ins.Stop, "--confirm-backup"):
                inst.execute()
            self.assertEqual(changes(run), [])
            self.assertEqual((Path(tmp) / ".env.production").read_text(), old_env_text())
            self.assertIn("PIX_FEE_CENTS=199", "\n".join(out))  # o resumo já foi mostrado

    def test_yes_with_migrations_runs_with_flag_or_env(self):
        for kw in ({"confirm_backup": True},
                   {"confirm_backup": False, "environ": {"CS_BACKUP_OK": "1", "CS_GHCR_TOKEN": TOKEN, "CS_GH_USER": "u"}}):
            with tempfile.TemporaryDirectory() as tmp, DNS_OK:
                inst, out = installer(make_old_root(tmp), srv(), update=True, input_fn=no_input, **kw)
                self.assertEqual(inst.execute(), 0)
                self.assertIn("Backup recente afirmado", "\n".join(out))

    def test_yes_without_migrations_needs_no_backup_flag(self):
        with tempfile.TemporaryDirectory() as tmp, DNS_OK:
            text = old_env_text() + f"CS_DEPLOYED_SHA={DEPLOYED}\n"
            inst, _ = installer(make_old_root(tmp, text), srv(diff=""), update=True, confirm_backup=False, input_fn=no_input)
            self.assertEqual(inst.execute(), 0)

    def test_interactive_enter_means_no_when_migrations_may_exist(self):
        prompts = []

        def answer(prompt):
            prompts.append(prompt)
            return ""

        with tempfile.TemporaryDirectory() as tmp, DNS_OK:
            run = srv()
            inst, _ = installer(make_old_root(tmp), run, yes=False, update=True, confirm_backup=False, input_fn=answer)
            with self.assertRaisesRegex(ins.Stop, "Cancelado"):
                inst.execute()
            self.assertEqual(changes(run), [])
            self.assertTrue(prompts[-1].endswith("[s/N]: "), prompts)
        with tempfile.TemporaryDirectory() as tmp, DNS_OK:
            inst, _ = installer(make_old_root(tmp), srv(), yes=False, update=True, confirm_backup=False,
                                input_fn=lambda p: "s")
            self.assertEqual(inst.execute(), 0)

    def test_card_off_is_stated_when_table_is_empty(self):
        with tempfile.TemporaryDirectory() as tmp, DNS_OK:
            text = old_env_text() + "PIX_FEE_CENTS=199\nCARD_FEE_TABLE=\nCARD_MIN_INSTALLMENT_CENTS=500\n"
            inst, out = installer(make_old_root(tmp, text), srv(), update=True, input_fn=no_input)
            inst.execute()
            self.assertIn("cartão: DESLIGADO", "\n".join(out))


class EnvFileSafetyTests(unittest.TestCase):
    """P2: cópia 0600, escrita atômica, CRLF preservado, pré-voo da stack, credenciais antigas, lock."""

    def test_backup_is_byte_exact_0600_and_crlf_is_preserved(self):
        text = old_env_text().replace("\n", "\r\n")
        with tempfile.TemporaryDirectory() as tmp, DNS_OK:
            root = make_old_root(tmp)
            (root / ".env.production").write_bytes(text.encode())
            inst, _ = installer(root, srv(), update=True, input_fn=no_input)
            self.assertEqual(inst.execute(), 0)
            backups = list(root.glob(".env.production.bak-*"))
            self.assertEqual(len(backups), 1)
            self.assertEqual(backups[0].read_bytes(), text.encode())
            self.assertEqual(stat.S_IMODE(backups[0].stat().st_mode), 0o600)
            new = (root / ".env.production").read_bytes().decode()
            self.assertIn("PIX_FEE_CENTS=199\r\n", new)
            self.assertIsNone(re.search(r"(?<!\r)\n", new))
            self.assertEqual(stat.S_IMODE((root / ".env.production").stat().st_mode), 0o600)
            self.assertEqual(list(root.glob(".env.production.tmp-*")), [])

    def test_atomic_write_keeps_original_when_replace_fails(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / ".env.production"
            path.write_text("A=1\n")
            with mock.patch.object(ins.os, "replace", side_effect=OSError("x")), self.assertRaises(OSError):
                ins.write_env_atomic(path, "A=2\n")
            self.assertEqual(path.read_text(), "A=1\n")
            self.assertEqual(list(Path(tmp).glob("*.tmp-*")), [])

    def test_backup_never_overwrites(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / ".env.production"
            path.write_text("A=1\n")
            first, second = ins.backup_env(path, "T"), ins.backup_env(path, "T")
            self.assertNotEqual(first, second)

    def test_stack_config_preflight_stops_before_creating_secrets(self):
        have = [n for n in sp.SECRET_NAMES if n != "pii_encryption_key"]
        fail = lambda a: a[:3] == ["docker", "stack", "config"]
        with tempfile.TemporaryDirectory() as tmp, DNS_OK:
            run = srv(secrets=have, fail=fail)
            inst, _ = installer(make_old_root(tmp), run, update=True, input_fn=no_input)
            with self.assertRaisesRegex(ins.Stop, "não fecha"):
                inst.execute()
            self.assertEqual(changes(run), [])
            self.assertEqual((Path(tmp) / ".env.production").read_text(), old_env_text())
        with tempfile.TemporaryDirectory() as tmp, DNS_OK:
            run = srv(secrets=have)
            installer(make_old_root(tmp), run, update=True, input_fn=no_input)[0].execute()
            cfg = run.ran("docker", "stack", "config")[0]
            self.assertEqual(cfg[2]["PIX_FEE_CENTS"], "199")  # env mesclado, não o arquivo cru
            self.assertEqual(cfg[2]["REINO_IMAGE_DIGEST"], NEW)
            self.assertLess(run.calls.index(cfg), run.calls.index(run.ran("docker", "secret", "create")[0]))

    def test_previous_credential_files_are_listed_at_start_and_end(self):
        with tempfile.TemporaryDirectory() as tmp, DNS_OK:
            root = make_old_root(tmp)
            secure = Path(tmp) / "secure"
            secure.mkdir()
            (secure / "credenciais-novos-ANTIGO-GUARDAR.txt").write_text("x=1\n")
            inst, out = installer(root, srv(), update=True, input_fn=no_input)
            inst.execute()
            self.assertEqual(sum("credenciais-novos-ANTIGO-GUARDAR.txt" in l for l in out), 2)

    def test_unparseable_value_is_never_overwritten_with_yes(self):
        text = old_env_text() + "CARD_MIN_INSTALLMENT_CENTS='500\n"
        with tempfile.TemporaryDirectory() as tmp, DNS_OK:
            run = srv()
            inst, _ = installer(make_old_root(tmp, text), run, update=True)
            with self.assertRaisesRegex(ins.Stop, "CARD_MIN_INSTALLMENT_CENTS.*ilegível"):
                inst.execute()
            self.assertEqual(changes(run), [])
            self.assertIn("CARD_MIN_INSTALLMENT_CENTS='500", (Path(tmp) / ".env.production").read_text())

    def test_lock_blocks_a_second_run_and_main_reports_it(self):
        with tempfile.TemporaryDirectory() as tmp:
            lock = Path(tmp) / "l.lock"
            fd = ins.acquire_lock(lock)
            try:
                with self.assertRaisesRegex(ins.Stop, "em andamento"):
                    ins.acquire_lock(lock)
            finally:
                os.close(fd)
            ins.os.close(ins.acquire_lock(lock))  # solto: volta a travar
        with mock.patch.object(ins.os, "geteuid", return_value=0), \
                mock.patch.dict(ins.os.environ, {"CS_LOCK_HELD": ""}), \
                mock.patch.object(ins, "acquire_lock", side_effect=ins.Stop("em andamento")), \
                mock.patch.object(ins, "Installer") as cls:
            self.assertEqual(ins.main(["--yes"]), 1)
            cls.assert_not_called()


if __name__ == "__main__":
    unittest.main()
