"""Passos de preparação do servidor: Docker, Swarm, portas, Traefik, login no GHCR e digests."""
from __future__ import annotations

import tempfile
from pathlib import Path

import install_detect as det
import install_traefik as tfk
import setup_production as sp
from install_core import GHCR, Core, Stop


class Steps(Core):
    def ensure_docker(self, pre: det.Preflight) -> det.Preflight:
        if pre.docker:
            self.ok("Docker: já instalado")
            return pre
        self.say("Docker não encontrado.")
        if not self.confirm("Instalar o Docker Engine com o script oficial (get.docker.com)?"):
            raise Stop("Docker é obrigatório. Instale-o e rode de novo.")
        if self.act("instalando o Docker Engine"):
            with tempfile.TemporaryDirectory() as tmp:
                script = Path(tmp) / "get-docker.sh"
                code, out = self.run(["curl", "-fsSL", "https://get.docker.com", "-o", str(script)])
                if code == 0:
                    code, out = self.run(["sh", str(script)])
                if code != 0:
                    raise Stop(f"falha ao instalar o Docker:\n{out[-800:]}")
            self.ok("Docker: instalado")
            return det.detect(self.run)
        return pre

    def check_ports(self, pre: det.Preflight) -> None:
        if pre.ss_failed:
            self.say("AVISO: não consegui verificar as portas 80/443 (o comando 'ss' falhou ou não existe). "
                     "Se outro programa usa essas portas, o Traefik não vai subir.")
        if not pre.port_conflicts:
            self.ok("Portas 80/443: sem conflito")
            return
        who = ", ".join(f"{c.process} (porta {c.port})" for c in pre.port_conflicts)
        self.fail(f"Portas 80/443: em uso por {who}")
        raise Stop(
            f"As portas 80/443 já estão em uso por: {who}.\n"
            "O Traefik precisa dessas portas. Não vou disputá-las.\n"
            "Pare o serviço (ex.: systemctl disable --now nginx) ou use o Traefik que já existe, e rode de novo.")

    def ensure_swarm(self, pre: det.Preflight) -> None:
        if pre.swarm_manager:
            self.ok("Swarm: este nó é manager")
            return
        if self.dry_run and not pre.docker:
            return
        if pre.swarm_active:
            raise Stop("Este nó faz parte de um Swarm, mas não é manager. Rode o instalador no manager.")
        if not self.confirm("O Swarm está inativo. Rodar 'docker swarm init' agora?"):
            raise Stop("O Swarm é obrigatório (docker-stack.yml).")
        if self.act("iniciando o Swarm"):
            code, out = self.run(["docker", "swarm", "init"])
            if code != 0:
                self.fail("Swarm: docker swarm init falhou")
                raise Stop(f"docker swarm init falhou (vários IPs? use --advertise-addr manualmente):\n{out[-600:]}")
            self.ok("Swarm: iniciado")

    def ensure_traefik(self, pre: det.Preflight, email: str) -> dict[str, str]:
        """Devolve os padrões de TRAEFIK_NETWORK / TRAEFIK_CERT_RESOLVER."""
        found = pre.traefik
        if found:
            for warning in found.warnings:
                self.say(f"AVISO: {warning}")
            if found.ambiguous:
                detail = "; ".join(found.ambiguous)
                if self.yes:
                    raise Stop(f"Há mais de uma opção no Traefik existente ({detail}). Rode sem --yes e escolha.")
                self.say(f"AVISO: mais de uma opção no Traefik ({detail}). Confira os padrões abaixo.")
            self.ok(f"Traefik: rede {found.network or '?'}, resolver {found.resolver or '?'} "
                    f"({found.name}, reaproveitado)")
            return {k: v for k, v in (("TRAEFIK_NETWORK", found.network),
                                      ("TRAEFIK_CERT_RESOLVER", found.resolver)) if v}
        self.say("Nenhum Traefik encontrado neste servidor.")
        if not self.confirm("Publicar um Traefik mínimo com Let's Encrypt?"):
            self.say("Ok. Informe a rede e o resolver do seu Traefik nas próximas perguntas.")
            return {}
        network = self.ask("Nome da rede overlay do Traefik", "RainhaNet", tfk.valid_name)
        resolver = self.ask("Nome do certresolver", "letsencryptresolver", tfk.valid_name)
        acme = self.ask("E-mail para o Let's Encrypt", email, sp.valid_email)
        if self.act(f"criando a rede '{network}' e publicando o Traefik"):
            code, out = self.run(["docker", "network", "create", "-d", "overlay", "--attachable", network])
            if code != 0 and "already exists" not in out:
                raise Stop(f"falha ao criar a rede '{network}':\n{out[-400:]}")
            path = self.secure_file("traefik-stack.yml", tfk.render_traefik_stack(network, resolver, acme), True)
            code, out = self.run(["docker", "stack", "deploy", "-c", str(path), tfk.TRAEFIK_STACK_NAME],
                                 cwd=self.root)
            if code != 0:
                self.fail("Traefik: falha ao publicar")
                raise Stop(f"falha ao publicar o Traefik:\n{out[-600:]}")
            self.ok(f"Traefik: rede {network}, resolver {resolver} (publicado)")
        return {"TRAEFIK_NETWORK": network, "TRAEFIK_CERT_RESOLVER": resolver}

    def registry_login(self) -> None:
        if not self.gh_token and not self.yes and not self.update:
            self.gh_token = self.getpass_fn("Token do GHCR com SÓ read:packages (vazio = imagens públicas): ")
        if not self.gh_token:
            self.ok("GHCR: sem token, sem login (imagens públicas)")
            return
        self.secret_values.add(self.gh_token)
        self.gh_user = self.gh_user or self.ask("Usuário do GitHub", "", lambda v: bool(v.strip()))
        self.docker_login()

    def docker_login(self) -> None:
        if not self.gh_token or not self.act("login no ghcr.io"):
            return
        code, _ = self.run(["docker", "login", GHCR, "-u", self.gh_user, "--password-stdin"], input=self.gh_token)
        if code != 0:
            self.fail("GHCR: login falhou")
            raise Stop("docker login no ghcr.io falhou. Confira o token (escopo read:packages) e o usuário.")
        self.logged_in = True
        self.ok(f"GHCR: login como {self.gh_user}")

    def registry_logout(self) -> None:
        if self.logged_in:
            self.run(["docker", "logout", GHCR])
            self.logged_in = False

    def resolve_digests(self, env: dict[str, str]) -> dict[str, str]:
        code, sha = self.run(["git", "-C", str(self.root), "rev-parse", "HEAD"])
        quiet = self.yes or self.update
        tag = sha.strip() if quiet and code == 0 else self.ask(
            "Tag das imagens (commit SHA publicado pelo CI)", sha.strip() if code == 0 else "", lambda v: bool(v.strip()))
        owner = env["REINO_IMAGE_OWNER"]
        result: dict[str, str] = {}
        for key, image in (("REINO_IMAGE_DIGEST", "reino-credito"), ("REINO_BACKUP_DIGEST", "reino-backup")):
            found = det.resolve_digest(f"{GHCR}/{owner}/{image}:{tag}", self.run, allow_pull=not self.dry_run)
            (self.ok if found else self.fail)(
                f"Digest {image}:{tag[:12]} -> {'sha256:' + found if found else 'não encontrado'}")
            if not found and quiet and not self.dry_run:
                raise Stop(f"Não achei o digest de {image}:{tag}. Não uso o digest antigo: a imagem desse commit ainda "
                           "não foi publicada (confira se o workflow 'Build and push images' desse commit terminou com "
                           "sucesso e espere), ou o login no GHCR falhou. Nada foi alterado no servidor.")
            result[key] = (found or env.get(key, "")) if self.update else self.ask(
                f"Digest de {image} (64 hex)", found or env.get(key, ""), lambda v: bool(sp._DIGEST.match(v)))
        return result
