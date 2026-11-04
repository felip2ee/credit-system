"""Stack mínima do Traefik v3 (Let's Encrypt por TLS-ALPN) para servidores que ainda não têm um."""
from __future__ import annotations

import re

# Confirme no servidor que a tag existe (docker pull traefik:v3.5) antes do primeiro uso.
TRAEFIK_IMAGE = "traefik:v3.5"
TRAEFIK_STACK_NAME = "traefik"
_NAME = re.compile(r"^[A-Za-z0-9_-]{1,63}$")


def valid_name(value: str) -> bool:
    """Nome de rede/resolver: vai para YAML e argumentos, então só caracteres seguros."""
    return bool(_NAME.match(value))


def render_traefik_stack(network: str, resolver: str, acme_email: str) -> str:
    from setup_production import valid_email
    if not (valid_name(network) and valid_name(resolver) and valid_email(acme_email)):
        raise ValueError("rede, resolver ou e-mail inválido para a stack do Traefik")
    return f"""# Gerado por scripts/setup/install.py
services:
  traefik:
    image: {TRAEFIK_IMAGE}
    command:
      - --providers.swarm=true
      - --providers.swarm.exposedByDefault=false
      - --providers.swarm.network={network}
      - --entrypoints.web.address=:80
      - --entrypoints.web.http.redirections.entryPoint.to=websecure
      - --entrypoints.web.http.redirections.entryPoint.scheme=https
      - --entrypoints.websecure.address=:443
      - --certificatesresolvers.{resolver}.acme.email={acme_email}
      - --certificatesresolvers.{resolver}.acme.storage=/letsencrypt/acme.json
      - --certificatesresolvers.{resolver}.acme.tlschallenge=true
    ports:
      - {{ target: 80, published: 80, mode: host }}
      - {{ target: 443, published: 443, mode: host }}
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock:ro
      - traefik_letsencrypt:/letsencrypt
    networks: [{network}]
    deploy:
      replicas: 1
      placement:
        constraints: [node.role == manager]
networks:
  {network}:
    external: true
volumes:
  traefik_letsencrypt:
"""
