import { isIP } from "node:net";

const USER_AGENT_MAX_LENGTH = 512;

// Mesma ordem de confirmScrSelfAuthorization. A coluna é inet: lixo no header derrubaria o cadastro.
export function requestMeta(headers: Pick<Headers, "get">): { ip: string | null; userAgent: string | null } {
  const candidate = (headers.get("x-forwarded-for")?.split(",")[0]?.trim() || headers.get("x-real-ip")?.trim()) ?? "";
  const userAgent = headers.get("user-agent")?.slice(0, USER_AGENT_MAX_LENGTH) ?? "";
  return { ip: isIP(candidate) ? candidate : null, userAgent: userAgent || null };
}
