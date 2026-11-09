"""Deploy e rollback do Installer: o rollback usa o docker-stack.yml da versão ANTERIOR, não o novo."""
from __future__ import annotations

import os
import shlex
import tempfile
from pathlib import Path

import install_detect as det
import install_update as upd
import install_verify as ver
from install_core import ENV_FILE, STACK, Stop, write_env_atomic
from install_secrets import Secrets


class Rollback(Secrets):
    def deploy(self, values: dict[str, str], stack_file: Path | None = None) -> tuple[int, str]:
        env = {**self.environ, **values}
        return self.run(["docker", "stack", "deploy", "--with-registry-auth", "-c",
                         str(stack_file or self.root / "docker-stack.yml"), STACK], env=env, cwd=self.root)

    def current_digest(self) -> str | None:
        app = det.service_names(STACK, self.run)["reino_app"]
        code, out = self.run(["docker", "service", "inspect", app, "--format",
                              "{{.Spec.TaskTemplate.ContainerSpec.Image}}"])
        return det.parse_digest(out) if code == 0 else None

    def previous_stack(self, sha: str) -> Path | None:
        """`git show <sha>:docker-stack.yml` num arquivo temporário 0600. None = usar o stack atual (com aviso)."""
        if not upd._SHA.match(sha):
            self.say("AVISO: CS_DEPLOYED_SHA é desconhecido: o rollback usa o docker-stack.yml NOVO com os digests antigos. "
                     "Se a stack nova não for compatível com a imagem antiga, o rollback pode falhar.")
            return None
        code, out = self.run(["git", "-C", str(self.root), "show", f"{sha}:docker-stack.yml"])
        if code != 0 or not out.strip():
            self.say(f"AVISO: não achei docker-stack.yml no commit {sha[:12]} (clone raso?): o rollback usa o docker-stack.yml "
                     "NOVO com os digests antigos.")
            return None
        fd, name = tempfile.mkstemp(prefix="docker-stack-anterior-", suffix=".yml")  # mkstemp já cria 0600
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            fh.write(out)
        return Path(name)

    def rollback(self, previous: str | None, new_digest: str, old_text: str, env_path: Path,
                 names: dict[str, str]) -> None:
        """Volta todos os serviços: restaura o .env.production antigo e refaz o deploy (idempotente)."""
        if not previous:
            self.say(f"Primeira instalação: não há versão anterior. A stack ficou no ar para inspeção; "
                     f"para remover: docker stack rm {STACK} (os volumes ficam).")
            return
        if previous == new_digest:
            self.say("O digest novo é igual ao anterior: não há o que reverter.")
            return
        state = ver.update_state(names["reino_app"], self.run)
        if state.startswith("rollback"):
            self.say(f"O Swarm já reverteu o app ({state}). Vou alinhar os outros serviços ao .env anterior.")
        self.say("==> restaurando o .env.production anterior e refazendo o deploy")
        write_env_atomic(env_path, old_text)
        old_env = det.parse_env(old_text)
        values = {**old_env, **self.reconciled}  # inofensivo se a stack antiga não usa as variáveis novas
        stack_file = self.previous_stack(old_env.get("CS_DEPLOYED_SHA", ""))
        try:
            try:
                self.docker_login()
            except Stop as exc:  # a imagem antiga costuma estar em cache: tenta o deploy mesmo assim
                self.say(f"AVISO: {exc} Tento o deploy do rollback mesmo assim (imagem antiga provavelmente em cache).")
            code, out = self.deploy(values, stack_file)
        finally:
            self.registry_logout()
            if stack_file:
                stack_file.unlink(missing_ok=True)
        if code == 0:
            self.say("Rollback concluído: stack refeita com a versão anterior.")
        else:
            self.not_applied(new_digest, old_env.get("CS_DEPLOYED_SHA", ""), out)
        self.say("Migrations não voltam: veja docs/operations/deploy.md, seção 6.")

    def not_applied(self, new_digest: str, sha: str, out: str) -> None:
        exports = "".join(f"export {k}={shlex.quote(v)} && " for k, v in self.reconciled.items())
        if upd._SHA.match(sha):
            stack = "/root/docker-stack-anterior.yml"
            prep = f"git -C {self.root} show {sha}:docker-stack.yml > {stack} && "
        else:
            stack, prep = str(self.root / "docker-stack.yml"), ""
        self.say(f"ROLLBACK NÃO APLICADO: produção está na versão nova sha256:{new_digest}.\n"
                 f"O {ENV_FILE} já voltou ao texto anterior. Faça à mão (seção 6 do runbook):\n"
                 f"  {prep}cd {self.root} && set -a && . ./{ENV_FILE} && set +a && {exports}"
                 f"docker stack deploy --with-registry-auth -c {stack} {STACK}\n"
                 f"Erro do deploy: {out[-400:]}")
