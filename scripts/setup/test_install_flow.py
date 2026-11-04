"""Testes de fluxo do Installer (execute, rollback, secrets, token). Rodam via test_install.py."""
import stat
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent))

import install as ins  # noqa: E402
import install_core as core  # noqa: E402
import install_detect as det  # noqa: E402
import setup_production as sp  # noqa: E402
from install_testkit import (APP, CLONE_TOKEN, LISTEN_NGINX, NEW, OLD, TOKEN, Fake, env_values,  # noqa: E402
                             installer, make_root, server)

DNS_OK = mock.patch.object(det.socket, "gethostbyname_ex", return_value=("h", [], ["203.0.113.9"]))
DNS_BAD = mock.patch.object(det.socket, "gethostbyname_ex", return_value=("h", [], ["198.51.100.1"]))
PROVIDED = {name: f"valor-{name}-abcdef" for name, *_ in sp.SECRET_QUESTIONS}


def first_input(prompt):
    if "[s/N]" in prompt:
        return "s"
    return "ops@exemplo.com.br" if "E-mail" in prompt else ""


def first_install(tmp, run, **kw):
    """Primeira instalação: sem .env, sem stack, sem secrets; `collect` simulado."""
    root = make_root(tmp, with_env=False)
    inst, out = installer(root, run, yes=False, input_fn=first_input, **kw)
    collected = (env_values(REINO_IMAGE_DIGEST="", REINO_BACKUP_DIGEST="", SUPERADMIN_EMAIL="a@b.co"), dict(PROVIDED))
    return root, inst, out, mock.patch.object(sp, "collect", return_value=collected)


class InstallerTests(unittest.TestCase):
    @staticmethod
    def log_calls(run, service):
        return len([c for c in run.ran("docker", "service", "logs") if c[0][-1] == service])

    def test_update_reuses_existing_secrets_and_creates_none(self):
        with tempfile.TemporaryDirectory() as tmp, DNS_OK:
            run = server()
            inst, _ = installer(make_root(tmp), run)
            self.assertEqual(inst.execute(), 0)
            self.assertEqual(run.ran("docker", "secret", "create"), [])
            self.assertEqual(run.ran("docker", "stack", "deploy")[0][2]["REINO_IMAGE_DIGEST"], NEW)
            text = (Path(tmp) / ".env.production").read_text()
            self.assertIn(f"REINO_IMAGE_DIGEST={NEW}", text)
            self.assertIn("LGPD_PURGE_ENABLED=1", text)

    def test_second_run_changes_nothing_and_never_rolls_back(self):
        with tempfile.TemporaryDirectory() as tmp, DNS_OK:
            root = make_root(tmp)
            installer(root, server())[0].execute()
            first = (root / ".env.production").read_text()
            run = server(current=NEW)
            inst, out = installer(root, run)
            self.assertEqual(inst.execute(), 0)
            self.assertEqual((root / ".env.production").read_text(), first)
            self.assertEqual(run.ran("docker", "secret", "create"), [])
            self.assertEqual(len(run.ran("docker", "stack", "deploy")), 1)
            self.assertNotIn("rollback", "\n".join(out).lower())

    def test_only_missing_secrets_are_created_and_saved_outside_git(self):
        have = [n for n in sp.SECRET_NAMES if n != "notifications_dispatch_secret"]
        with tempfile.TemporaryDirectory() as tmp, DNS_OK:
            run = server(secrets=have)
            inst, _ = installer(make_root(tmp), run)
            inst.execute()
            self.assertEqual([c[0][3] for c in run.ran("docker", "secret", "create")], ["notifications_dispatch_secret"])
            saved = Path(tmp) / "secure" / "credenciais-novos-T1-GUARDAR.txt"
            self.assertTrue(saved.read_text().startswith("notifications_dispatch_secret="))
            self.assertEqual(stat.S_IMODE(saved.stat().st_mode), 0o600)
            self.assertFalse(list(Path(tmp).glob("credenciais*")))

    def test_earlier_credential_file_is_never_truncated(self):
        have = [n for n in sp.SECRET_NAMES if n != "notifications_dispatch_secret"]
        with tempfile.TemporaryDirectory() as tmp, DNS_OK:
            inst, _ = installer(make_root(tmp), server(secrets=have))
            (Path(tmp) / "secure").mkdir()
            (Path(tmp) / "secure" / "credenciais-novos-T1-GUARDAR.txt").write_text("antigo")
            with self.assertRaises(FileExistsError):
                inst.provision_secrets(True, {}, {}, det.detect(server(secrets=have)))
            self.assertEqual((Path(tmp) / "secure" / "credenciais-novos-T1-GUARDAR.txt").read_text(), "antigo")

    def test_first_install_path(self):
        with tempfile.TemporaryDirectory() as tmp, DNS_OK:
            run = server(stack=False, secrets=[], traefik=False)
            root, inst, _, collect = first_install(tmp, run)
            with collect:
                self.assertEqual(inst.execute(), 0)
            secure = Path(tmp) / "secure"
            self.assertEqual(stat.S_IMODE(secure.stat().st_mode), 0o700)
            for path in (root / ".env.production", secure / "credenciais-T1-GUARDAR.txt", secure / "traefik-stack.yml"):
                self.assertEqual(stat.S_IMODE(path.stat().st_mode), 0o600, path)
            self.assertFalse((root / "traefik-stack.yml").exists())
            self.assertNotIn("swarmMode", (secure / "traefik-stack.yml").read_text())
            self.assertIn(f"REINO_IMAGE_DIGEST={NEW}", (root / ".env.production").read_text())
            order = [c[0][:3] for c in run.calls if c[0][:2] in (["docker", "stack"], ["docker", "secret"])
                     and c[0][2] in ("deploy", "create")]
            self.assertEqual(order[0], ["docker", "stack", "deploy"])  # Traefik primeiro
            self.assertEqual([c[0][3] for c in run.ran("docker", "secret", "create")], sp.SECRET_NAMES)
            self.assertEqual(order[-1], ["docker", "stack", "deploy"])
            self.assertEqual(len(run.ran("docker", "stack", "deploy")), 2)
            self.assertIn("-c", run.ran("docker", "stack", "deploy")[0][0])
            self.assertFalse([c for c in run.calls if "{{.Spec.TaskTemplate.ContainerSpec.Image}}" in c[0]])  # sem versão anterior

    def test_partial_secret_failure_cleans_up(self):
        third = sp.SECRET_NAMES[2]
        fail = lambda a: a[:3] == ["docker", "secret", "create"] and a[3] == third
        with tempfile.TemporaryDirectory() as tmp, DNS_OK:
            run = server(stack=False, secrets=[], traefik=True, fail=fail)
            root, inst, out, collect = first_install(tmp, run)
            with collect, self.assertRaisesRegex(ins.Stop, "Desfiz"):
                inst.execute()
            self.assertEqual([c[0][3] for c in run.ran("docker", "secret", "rm")], sp.SECRET_NAMES[:2])
            self.assertFalse((root / ".env.production").exists())
            self.assertEqual(list((Path(tmp) / "secure").glob("credenciais*")), [])
            self.assertEqual(run.ran("docker", "stack", "deploy"), [])

    def test_skipped_secrets_are_reported_and_dropped_from_credentials(self):
        have = ["notifications_dispatch_secret"]
        with tempfile.TemporaryDirectory() as tmp, DNS_OK:
            run = server(stack=False, secrets=have)
            root, inst, out, collect = first_install(tmp, run)
            with collect:
                inst.execute()
            text = (Path(tmp) / "secure" / "credenciais-T1-GUARDAR.txt").read_text()
            self.assertNotIn("notifications_dispatch_secret=", text)
            self.assertIn("postgres_password=", text)
            self.assertIn("notifications_dispatch_secret", "\n".join(out))

    def test_partial_database_secrets_stop(self):
        with tempfile.TemporaryDirectory() as tmp:
            inst, _ = installer(make_root(tmp), server(secrets=["postgres_password"]))
            with self.assertRaisesRegex(ins.Stop, "Postgres"):
                inst.execute()

    def test_reuse_missing_restic_password_stops(self):
        have = [n for n in sp.SECRET_NAMES if n != "restic_password"]
        with tempfile.TemporaryDirectory() as tmp:
            run = server(secrets=have)
            inst, _ = installer(make_root(tmp), run)
            with self.assertRaisesRegex(ins.Stop, "restic_password"):
                inst.execute()
            self.assertEqual(run.ran("docker", "secret", "create"), [])

    def test_no_db_secrets_but_postgres_volume_stops(self):
        with tempfile.TemporaryDirectory() as tmp:
            run = server(stack=False, secrets=[], volumes="reino_postgres_data\n")
            inst, _ = installer(make_root(tmp), run)
            with self.assertRaisesRegex(ins.Stop, "volume"):
                inst.execute()
            self.assertEqual(run.ran("docker", "secret", "create"), [])

    def test_update_only_needs_a_stack_before_any_side_effect(self):
        with tempfile.TemporaryDirectory() as tmp:
            run = Fake(lambda a: (127, "") if a[0] == "docker" else None)
            inst, _ = installer(make_root(tmp), run, update_only=True)
            with self.assertRaisesRegex(ins.Stop, "update-only"):
                inst.execute()
            self.assertEqual(run.mutations(), [])

    def test_yes_is_refused_on_first_install_before_any_side_effect(self):
        with tempfile.TemporaryDirectory() as tmp:
            run = server(stack=False, secrets=[])
            inst, _ = installer(make_root(tmp, with_env=False), run, yes=True)
            with self.assertRaisesRegex(ins.Stop, "primeira instalação"):
                inst.execute()
            self.assertEqual(run.mutations(), [])

    def test_yes_fails_when_digest_cannot_be_resolved(self):
        with tempfile.TemporaryDirectory() as tmp, DNS_OK:
            run = server(buildx=False, fail=lambda a: a[:2] == ["docker", "pull"])
            inst, _ = installer(make_root(tmp), run)
            with self.assertRaisesRegex(ins.Stop, "digest"):
                inst.execute()
            self.assertEqual(run.ran("docker", "stack", "deploy"), [])
            self.assertTrue(run.ran("docker", "logout"))  # login feito é desfeito mesmo na falha

    def test_failed_app_rolls_back_by_redeploying_old_env(self):
        with tempfile.TemporaryDirectory() as tmp, DNS_OK:
            root = make_root(tmp)
            before = (root / ".env.production").read_text()
            run = server(tasks_state="Failed 1 second ago")
            inst, out = installer(root, run)
            self.assertEqual(inst.execute(), 1)
            deploys = run.ran("docker", "stack", "deploy")
            self.assertEqual([d[2]["REINO_IMAGE_DIGEST"] for d in deploys], [NEW, OLD])
            self.assertEqual(run.ran("docker", "service", "rollback"), [])
            self.assertEqual((root / ".env.production").read_text(), before)
            self.assertEqual(self.log_calls(run, APP), 1)
            text = "\n".join(out)
            self.assertIn("boom", text)
            self.assertIn("Migrations não voltam", text)
            self.assertNotIn(TOKEN, text)

    def test_failed_migrate_also_rolls_back(self):
        with tempfile.TemporaryDirectory() as tmp, DNS_OK:
            run = server(migrate="Failed 1 second ago")
            self.assertEqual(installer(make_root(tmp), run)[0].execute(), 1)
            self.assertEqual(len(run.ran("docker", "stack", "deploy")), 2)
            self.assertEqual(self.log_calls(run, "reino_migrate"), 1)

    def test_swarm_rollback_state_is_reported_as_already_rolled_back(self):
        with tempfile.TemporaryDirectory() as tmp, DNS_OK:
            inst, out = installer(make_root(tmp), server(update="rollback_completed"))
            self.assertEqual(inst.execute(), 1)
            self.assertIn("Swarm já reverteu", "\n".join(out))

    def test_rollback_skipped_when_digest_unchanged(self):
        with tempfile.TemporaryDirectory() as tmp, DNS_OK:
            run = server(current=NEW, tasks_state="Failed 1 second ago")
            inst, out = installer(make_root(tmp), run)
            self.assertEqual(inst.execute(), 1)
            self.assertEqual(len(run.ran("docker", "stack", "deploy")), 1)
            self.assertIn("igual ao anterior", "\n".join(out))

    def test_tls_only_failure_does_not_roll_back(self):
        with tempfile.TemporaryDirectory() as tmp, DNS_OK:
            root = make_root(tmp)
            run = server()
            inst, out = installer(root, run, tls=lambda h: (False, "certificado padrão"))
            self.assertEqual(inst.execute(), 1)
            self.assertEqual(len(run.ran("docker", "stack", "deploy")), 1)
            self.assertIn(f"REINO_IMAGE_DIGEST={NEW}", (root / ".env.production").read_text())
            self.assertIn("Não fiz rollback", "\n".join(out))

    def test_http_failure_does_not_roll_back(self):
        with tempfile.TemporaryDirectory() as tmp, DNS_OK:
            run = server()
            self.assertEqual(installer(make_root(tmp), run, http=lambda u, t: 502)[0].execute(), 1)
            self.assertEqual(len(run.ran("docker", "stack", "deploy")), 1)

    def test_deploy_command_failure_keeps_services_and_restores_env_file(self):
        with tempfile.TemporaryDirectory() as tmp, DNS_OK:
            root = make_root(tmp)
            before = (root / ".env.production").read_text()
            run = server(fail=lambda a: a[:3] == ["docker", "stack", "deploy"])
            self.assertEqual(installer(root, run)[0].execute(), 1)
            self.assertEqual((root / ".env.production").read_text(), before)
            self.assertEqual(len(run.ran("docker", "stack", "deploy")), 1)

    def test_dns_mismatch_never_prints_pronto(self):
        with tempfile.TemporaryDirectory() as tmp, DNS_BAD:
            inst, out = installer(make_root(tmp), server())
            self.assertEqual(inst.execute(), 0)
            text = "\n".join(out)
            self.assertIn("app OK localmente; DNS ainda não aponta para este servidor", text)
            self.assertNotIn("PRONTO", text)

    def test_dns_ok_prints_pronto(self):
        with tempfile.TemporaryDirectory() as tmp, DNS_OK:
            inst, out = installer(make_root(tmp), server())
            inst.execute()
            self.assertIn("PRONTO: https://app.exemplo.com.br", "\n".join(out))

    def test_yes_stops_on_ambiguous_traefik(self):
        spec = '{"ContainerSpec": {"Args": ["--providers.swarm=true", "--certificatesresolvers.a.acme.x=1", ' \
               '"--certificatesresolvers.b.acme.x=1"]}, "Networks": []}'
        with tempfile.TemporaryDirectory() as tmp:
            inst, _ = installer(make_root(tmp), server(spec=spec))
            with self.assertRaisesRegex(ins.Stop, "mais de uma opção"):
                inst.execute()

    def test_conflict_stops_before_any_change(self):
        with tempfile.TemporaryDirectory() as tmp:
            run = server(stack=False, listen=LISTEN_NGINX)
            inst, _ = installer(make_root(tmp), run)
            with self.assertRaisesRegex(ins.Stop, "nginx"):
                inst.execute()
            self.assertEqual(run.mutations(), [])

    def test_ss_failure_warns_loudly(self):
        base = server()
        with tempfile.TemporaryDirectory() as tmp, DNS_OK:
            inst, out = installer(make_root(tmp), Fake(lambda a: (127, "") if a[0] == "ss" else base.script(a)))
            inst.execute()
            self.assertIn("não consegui verificar as portas", "\n".join(out))

    def test_missing_docker_needs_confirmation(self):
        run = Fake(lambda a: (127, "") if a[0] == "docker" else None)
        inst, _ = installer(Path("/nonexistent"), run, yes=False, input_fn=lambda p: "n")
        with self.assertRaisesRegex(ins.Stop, "Docker é obrigatório"):
            inst.execute()

    def test_dry_run_changes_nothing_and_never_pulls(self):
        with tempfile.TemporaryDirectory() as tmp, DNS_OK:
            root = make_root(tmp)
            before = (root / ".env.production").read_text()
            run = server(buildx=False)
            inst, _ = installer(root, run, dry_run=True)
            self.assertEqual(inst.execute(), 0)
            self.assertEqual(run.mutations(), [])
            self.assertEqual((root / ".env.production").read_text(), before)
            self.assertFalse((Path(tmp) / "secure").exists())


class FlowTests(unittest.TestCase):
    def test_token_never_reaches_child_processes_argv_env_or_output(self):
        with tempfile.TemporaryDirectory() as tmp, DNS_OK:
            run = server(tasks_state="Failed 1 second ago")
            inst, out = installer(make_root(tmp), run)
            inst.execute()
            for args, _, env in run.calls:
                self.assertNotIn(TOKEN, " ".join(args))
                self.assertNotIn(CLONE_TOKEN, " ".join(args))
                values = " ".join((env or {}).values())
                self.assertFalse({"CS_GH_TOKEN", "CS_GHCR_TOKEN", "CS_GH_USER"} & set(env or {}), args)
                self.assertNotIn(TOKEN, values)
                self.assertNotIn(CLONE_TOKEN, values)
            login = run.ran("docker", "login")[0]
            self.assertEqual((login[1], "--password-stdin" in login[0]), (TOKEN, True))
            text = "\n".join(out)
            for leak in (TOKEN, "hunter2pw"):
                self.assertNotIn(leak, text)

    def test_registry_logout_follows_deploy(self):
        with tempfile.TemporaryDirectory() as tmp, DNS_OK:
            run = server()
            installer(make_root(tmp), run)[0].execute()
            kinds = [c[0][1] for c in run.calls if c[0][:2] in (["docker", "login"], ["docker", "logout"])
                     or c[0][:3] == ["docker", "stack", "deploy"]]
            self.assertEqual(kinds, ["login", "stack", "logout"])

    def test_default_runner_scrubs_github_variables(self):
        with mock.patch.object(core.subprocess, "run") as sub, \
                mock.patch.dict(core.os.environ, {"CS_GH_TOKEN": "a", "CS_GHCR_TOKEN": "b", "KEEP": "1"}):
            sub.return_value = mock.Mock(returncode=0, stdout="", stderr="")
            core.default_runner(["x"])
            core.default_runner(["x"], env={"CS_GH_USER": "u", "KEEP": "2"})
        self.assertEqual(sub.call_args_list[0].kwargs["env"]["KEEP"], "1")
        for call in sub.call_args_list:
            self.assertFalse({"CS_GH_TOKEN", "CS_GHCR_TOKEN", "CS_GH_USER"} & set(call.kwargs["env"]))

    def test_main_pops_github_variables_from_process_environment(self):
        env = {"CS_GH_TOKEN": "a", "CS_GHCR_TOKEN": TOKEN, "CS_GH_USER": "u"}
        with mock.patch.dict(core.os.environ, env), \
                mock.patch.object(ins, "Installer") as cls:
            cls.return_value.execute.return_value = 0
            self.assertEqual(ins.main(["--dry-run"]), 0)
            self.assertFalse(set(env) & set(core.os.environ))
        self.assertEqual(cls.call_args.kwargs["gh_token"], TOKEN)


if __name__ == "__main__":
    unittest.main()
