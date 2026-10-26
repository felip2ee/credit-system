// Datas de corte do repasse em America/Sao_Paulo. Client-safe: não importa módulo de servidor.
const SAO_PAULO_TZ = "America/Sao_Paulo";

// Deslocamento de São Paulo em relação a UTC (ms) no instante dado; independe do fuso do navegador.
function saoPauloOffsetMs(at: Date): number {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone: SAO_PAULO_TZ,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    })
      .formatToParts(at)
      .map((part) => [part.type, Number(part.value)]),
  );
  return Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second) - at.getTime();
}

// "AAAA-MM-DD" -> instante ISO de 23:59:59 desse dia em America/Sao_Paulo (qualquer fuso do navegador); null se a data for inválida.
export function cutoffFromDate(date: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  const wallClockAsUtc = new Date(`${date}T23:59:59Z`);
  if (Number.isNaN(wallClockAsUtc.getTime())) return null;
  return new Date(wallClockAsUtc.getTime() - saoPauloOffsetMs(wallClockAsUtc)).toISOString();
}

export const DAY_MS = 86_400_000;
const END_OF_DAY_MS = DAY_MS - 1_000; // o corte de uma data vale 23:59:59

// Última data (AAAA-MM-DD, São Paulo) cujo corte de 23:59:59 já passou da retenção: create_payout aceita até now() − prazo.
export function latestPayoutDate(retentionDays: number, now: Date = new Date()): string {
  const limit = new Date(now.getTime() - retentionDays * DAY_MS - END_OF_DAY_MS);
  return new Intl.DateTimeFormat("en-CA", { timeZone: SAO_PAULO_TZ }).format(limit);
}

// "AAAA-MM-DD" -> "DD/MM/AAAA".
export const brDate = (isoDate: string) => isoDate.split("-").reverse().join("/");
