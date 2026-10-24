import { BlockList, isIP } from "node:net";

import { config } from "@/lib/config";

const USER_AGENT_MAX_LENGTH = 512;

function trustedProxies(cidr: string | undefined): BlockList {
  const list = new BlockList();
  if (!cidr) return list;
  const [address, prefix] = cidr.split("/");
  list.addSubnet(address, Number(prefix), isIP(address) === 6 ? "ipv6" : "ipv4");
  return list;
}

// X-Forwarded-For: o cliente controla o início; cada proxy confiável acrescenta o fim.
// Percorre da direita para a esquerda e devolve o primeiro salto fora de TRAEFIK_PROXY_CIDR.
function clientIp(headers: Pick<Headers, "get">): string | null {
  const forwarded = headers.get("x-forwarded-for");
  const proxies = trustedProxies(config.traefikProxyCidr);
  if (forwarded) {
    for (const hop of forwarded.split(",").map((value) => value.trim()).reverse()) {
      const family = isIP(hop);
      if (!family) return null;
      if (!proxies.check(hop, family === 6 ? "ipv6" : "ipv4")) return hop;
    }
    return null;
  }
  // Sem proxy confiável configurado (dev local) x-real-ip é o único sinal; em produção o cliente o forjaria.
  const real = config.traefikProxyCidr ? "" : (headers.get("x-real-ip")?.trim() ?? "");
  return isIP(real) ? real : null;
}

// A coluna é inet: lixo no header derrubaria o cadastro, por isso só devolvemos IP válido.
export function requestMeta(headers: Pick<Headers, "get">): { ip: string | null; userAgent: string | null } {
  const userAgent = headers.get("user-agent")?.slice(0, USER_AGENT_MAX_LENGTH) ?? "";
  return { ip: clientIp(headers), userAgent: userAgent || null };
}
