"""Testes do instalador: detecção, verificação, Traefik. Os testes de fluxo ficam em test_install_flow.py."""
import io
import json
import sys
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent))

import install_detect as det  # noqa: E402
import install_traefik as tfk  # noqa: E402
import install_verify as ver  # noqa: E402
import setup_production as sp  # noqa: E402
from install_testkit import (APP, LISTEN_DOCKER, LISTEN_NGINX, LISTEN_NO_USERS, NEW, OLD, STACK_SERVICES,  # noqa: E402
                             TRAEFIK_ARGS, Fake, fake_clock, server)
from test_install_flow import FlowTests, InstallerTests  # noqa: E402,F401  (rodam junto com este módulo)

NAMES = {"reino_app": APP, "migrate": "reino_migrate"}


def spec(args, nets=("net1",)):
    return json.dumps({"ContainerSpec": {"Args": args}, "Networks": [{"Target": n} for n in nets]})


class DetectTests(unittest.TestCase):
    def test_traefik_service_gives_network_and_resolver(self):
        found = det.detect_traefik(server())
        self.assertEqual((found.network, found.resolver, found.warnings), ("RainhaNet", "le", []))

    def test_traefik_container_falls_back_to_first_user_network(self):
        def script(a):
            if a[:2] == ["docker", "ps"]:
                return 0, "abc\ttraefik:v2.11\ttraefik\n"
            if a[:2] == ["docker", "inspect"]:
                return 0, json.dumps({"Args": ["--certificatesresolvers.cf.acme.x=1"],
                                      "NetworkSettings": {"Networks": {"bridge": {}, "proxy": {}}}})
            if a[:3] == ["docker", "network", "inspect"]:
                return 0, "swarm overlay"
        found = det.detect_traefik(Fake(script))
        self.assertEqual((found.name, found.network, found.resolver), ("traefik", "proxy", "cf"))

    def test_no_traefik(self):
        self.assertIsNone(det.detect_traefik(server(traefik=False)))

    def test_traefik_image_regex(self):
        for ok in ("traefik", "traefik:v3.5", "ghcr.io/x/traefik:v3", "docker.io/library/traefik@sha256:ab"):
            self.assertTrue(det.TRAEFIK_IMAGE.match(ok), ok)
        for bad in ("mytraefik:1", "nginx/traefik-proxy:1", "traefikee:1", "ghcr.io/x/not-traefik"):
            self.assertFalse(det.TRAEFIK_IMAGE.match(bad), bad)

    def test_network_must_be_swarm_overlay(self):
        found = det.detect_traefik(server(net_scope="local bridge"))
        self.assertEqual(found.network, "")
        self.assertTrue(any("overlay" in w for w in found.warnings))

    def test_warns_without_swarm_provider_or_websecure(self):
        found = det.detect_traefik(server(spec=spec(["--providers.file.directory=/etc"])))
        text = " ".join(found.warnings)
        self.assertIn("provider swarm", text)
        self.assertIn("websecure", text)

    def test_multiple_resolvers_and_networks_are_ambiguous(self):
        args = TRAEFIK_ARGS[2:] + ["--certificatesresolvers.zz.acme.email=a@b.c"]
        found = det.detect_traefik(server(spec=spec(args, ("n1", "n2"))))
        self.assertEqual(len(found.ambiguous), 2)

    def test_nginx_on_80_conflicts_even_with_traefik(self):
        listeners = det.parse_listeners(LISTEN_NGINX)
        self.assertEqual(len(det.find_port_conflicts(listeners, det.TraefikInfo("t"))), 1)

    def test_docker_proxy_is_fine_with_traefik_but_not_without(self):
        listeners = det.parse_listeners(LISTEN_DOCKER)
        self.assertEqual(det.find_port_conflicts(listeners, det.TraefikInfo("t")), [])
        self.assertEqual(len(det.find_port_conflicts(listeners, None)), 1)

    def test_ipv6_listener_without_users_column_conflicts(self):
        found = det.parse_listeners(LISTEN_NO_USERS)
        self.assertEqual([(l.port, l.process) for l in found], [(80, "desconhecido")])
        self.assertEqual(len(det.find_port_conflicts(found, det.TraefikInfo("t"))), 1)

    def test_ss_failure_is_flagged(self):
        base = server()
        pre = det.detect(Fake(lambda a: (127, "não encontrado") if a[0] == "ss" else base.script(a)))
        self.assertTrue(pre.ss_failed)
        self.assertFalse(det.detect(server()).ss_failed)

    def test_postgres_volume_is_detected(self):
        self.assertEqual(det.detect(server(volumes="reino_postgres_data\nother\n")).postgres_volumes,
                         ["reino_postgres_data"])

    def test_service_names_use_real_swarm_names_with_fallback(self):
        names = det.service_names("reino", server())
        self.assertEqual(names["reino_app"], "reino_reino_app")
        self.assertEqual(names["migrate"], "reino_migrate")
        self.assertEqual(names["notifications_cron"], "reino_notifications_cron")
        self.assertEqual(det.service_names("reino", Fake(lambda a: (1, "")))["reino_app"], "reino_reino_app")
        self.assertIn("reino_reino_app", STACK_SERVICES)

    def test_parse_digest_variants(self):
        self.assertEqual(det.parse_digest(f"Digest:    sha256:{NEW}"), NEW)
        self.assertEqual(det.parse_digest(f"ghcr.io/x/y@sha256:{OLD}"), OLD)
        self.assertIsNone(det.parse_digest("erro"))

    def test_resolve_digest_falls_back_to_pull(self):
        def script(a):
            if a[:3] == ["docker", "buildx", "imagetools"]:
                return 1, "unknown"
            if a[:2] == ["docker", "image"]:
                return 0, f"ghcr.io/x/y@sha256:{OLD}"
        self.assertEqual(det.resolve_digest("ghcr.io/x/y:t", Fake(script)), OLD)

    def test_resolve_digest_without_pull_never_pulls(self):
        run = Fake(lambda a: (1, "") if a[1] in ("buildx", "pull") else None)
        self.assertIsNone(det.resolve_digest("r", run, allow_pull=False))
        self.assertEqual(run.ran("docker", "pull"), [])
        self.assertIsNone(det.resolve_digest("r", run))

    def test_partial_db_secrets(self):
        self.assertTrue(det.partial_db_secrets({"postgres_password"}))
        self.assertFalse(det.partial_db_secrets(set()))
        self.assertFalse(det.partial_db_secrets(set(det.DB_SECRETS)))

    def test_env_roundtrip_keeps_unknown_lines(self):
        text = "A='x y'\nLGPD_PURGE_ENABLED=1\n"
        self.assertEqual(det.parse_env(text)["A"], "x y")
        new = det.set_env_value(text, "A", "z")
        self.assertIn("LGPD_PURGE_ENABLED=1", new)
        self.assertIn("B=1", det.set_env_value(new, "B", "1"))

    def test_dns_check(self):
        self.assertTrue(det.dns_check("a.b.c", "1.2.3.4", lambda d: ["1.2.3.4"])[0])
        self.assertFalse(det.dns_check("a.b.c", "1.2.3.4", lambda d: ["9.9.9.9"])[0])

        def boom(d):
            raise OSError
        self.assertFalse(det.dns_check("a.b.c", "1.2.3.4", boom)[0])


class TraefikTests(unittest.TestCase):
    def test_stack_uses_v3_swarm_provider_and_pinned_tag(self):
        text = tfk.render_traefik_stack("RainhaNet", "le", "a@b.co")
        self.assertIn("certificatesresolvers.le.acme.email=a@b.co", text)
        self.assertIn("--providers.swarm=true", text)
        self.assertIn("--providers.swarm.exposedByDefault=false", text)
        self.assertIn("--providers.swarm.network=RainhaNet", text)
        self.assertNotIn("swarmMode", text)
        self.assertIn("image: traefik:v3.5", text)

    def test_invalid_names_and_emails_are_rejected(self):
        for net in ("a b", "x\nevil: 1", "a/b", "", "x" * 64):
            with self.assertRaises(ValueError):
                tfk.render_traefik_stack(net, "le", "a@b.co")
        with self.assertRaises(ValueError):
            tfk.render_traefik_stack("net", "le;rm", "a@b.co")
        self.assertTrue(tfk.valid_name("Rainha_Net-1"))

    def test_email_rejects_yaml_and_arg_breakers(self):
        for bad in ("a#b@c.com", "a{b}@c.com", 'a"b@c.com', "a@b", "a b@c.com"):
            self.assertFalse(sp.valid_email(bad), bad)
        self.assertTrue(sp.valid_email("no-reply@exemplo.com.br"))
        with self.assertRaises(ValueError):
            tfk.render_traefik_stack("net", "le", 'a"b@c.com')


class VerifyTests(unittest.TestCase):
    def checks(self, run, http=lambda u, t: 200, tls=lambda h: (True, ""), names=NAMES):
        return ver.run_checks("app.x.com", NEW, run, http, tls, lambda m: None, lambda s: None, fake_clock(),
                              names, 5, 5, 5)

    def test_wait_until_retries_then_succeeds(self):
        attempts = []

        def probe():
            attempts.append(1)
            return len(attempts) == 3, f"t{len(attempts)}"
        self.assertEqual(ver.wait_until(probe, 100, 1, lambda s: None, fake_clock()), (True, "t3"))

    def test_wait_until_times_out_with_last_detail(self):
        self.assertEqual(ver.wait_until(lambda: (False, "nada"), 5, 1, lambda s: None, fake_clock()), (False, "nada"))

    def test_all_checks_pass_and_use_real_service_names(self):
        run = server()
        checks = self.checks(run)
        self.assertEqual(len(checks), ver.TOTAL_CHECKS)
        self.assertTrue(all(c.ok for c in checks))
        self.assertTrue(run.ran("docker", "service", "ps", APP))
        self.assertFalse(run.ran("docker", "service", "ps", "reino_app"))

    def test_only_migrate_and_app_are_critical(self):
        checks = self.checks(server())
        self.assertEqual([c.critical for c in checks], [True, True, False, False, False, False])

    def test_stops_at_first_failure_and_reports_it(self):
        urls = []

        def http(u, t):
            urls.append(u)
            return 503 if u.endswith("ready") else 200
        checks = self.checks(server(), http)
        self.assertEqual(checks[-1].name, "health ready")
        self.assertFalse(checks[-1].critical)
        self.assertFalse(any(u.endswith("/login") for u in urls))

    def test_migrate_failed_is_not_complete(self):
        checks = self.checks(server(migrate="Failed 1 second ago"))
        self.assertEqual(ver.failing_service(checks, NAMES), "reino_migrate")
        self.assertTrue(checks[-1].critical)

    def test_old_image_task_is_ignored(self):
        self.assertFalse(ver.migrate_probe("c" * 64, server(), "reino_migrate")()[0])

    def test_app_restart_loop_is_failure(self):
        run = Fake(lambda a: (0, "Failed 2s ago\timg@sha256:%s\nFailed 9s ago\timg@sha256:%s\n" % (NEW, NEW))
                   if a[:3] == ["docker", "service", "ps"] else None)
        self.assertIn("loop", ver.app_probe(NEW, run, APP)()[1])

    def test_swarm_rollback_state_fails_app_probe(self):
        self.assertIn("rollback", ver.app_probe(NEW, server(update="rollback_started"), APP)()[1])

    def test_http_and_tls_connect_to_loopback(self):
        for call in (lambda: ver.http_status("https://app.x.com/login", 1), lambda: ver.tls_check("app.x.com")):
            with mock.patch.object(ver.socket, "create_connection", side_effect=OSError("x")) as conn:
                call()
            self.assertEqual(conn.call_args[0][0], ("127.0.0.1", 443))

    def test_http_sends_sni_and_host_of_the_domain(self):
        sock = mock.Mock()
        ctx = mock.Mock()
        ctx.wrap_socket.return_value.makefile.return_value = io.BytesIO(b"HTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n")
        with mock.patch.object(ver.socket, "create_connection", return_value=sock), \
                mock.patch.object(ver.ssl, "create_default_context", return_value=ctx):
            self.assertEqual(ver.http_status("https://app.x.com/login", 1), 200)
        self.assertEqual(ctx.wrap_socket.call_args.kwargs["server_hostname"], "app.x.com")
        sent = b"".join(c.args[0] for c in ctx.wrap_socket.return_value.sendall.call_args_list)
        self.assertIn(b"Host: app.x.com\r\n", sent)

    def test_redact_hides_urls_kv_and_known_values(self):
        text = ver.redact("postgresql://u:hunter2pw@h/db token=abc123 xyz-secret-val", {"xyz-secret-val"})
        for leak in ("hunter2pw", "abc123", "xyz-secret-val"):
            self.assertNotIn(leak, text)

    def test_redact_json_and_bearer(self):
        self.assertEqual(ver.redact('{"password":"x"}'), '{"password":"***"}')
        self.assertEqual(ver.redact('{"token": "abcdef"}'), '{"token": "***"}')
        self.assertEqual(ver.redact("Authorization: Bearer abc.def.ghi"), "Authorization: Bearer ***")
        self.assertNotIn("zzz", ver.redact('x {"api_key":"zzz","a":1} authorization=Basic zzz'))


if __name__ == "__main__":
    unittest.main()
