// Lógica pura das telas de repasse. Client-safe: não importa módulo de servidor.
// O limite espelha MAX_RECEIPT_BYTES de src/lib/payouts/receipt.ts (que importa storage de servidor);
// o servidor decide, esta checagem só poupa o envio.
export const MAX_RECEIPT_BYTES = 5 * 1024 * 1024;
export const RECEIPT_ACCEPT = ".pdf,.png,.jpg,.jpeg";

const ALLOWED_EXTENSIONS = ["pdf", "png", "jpg", "jpeg"];

export function validateReceiptFile(file: { name: string; size: number } | null | undefined): string | null {
  if (!file || file.size === 0) return "Anexe o comprovante do repasse.";
  const extension = file.name.split(".").pop()?.toLowerCase() ?? "";
  if (!ALLOWED_EXTENSIONS.includes(extension)) return "Envie o comprovante em PDF, PNG ou JPEG.";
  if (file.size > MAX_RECEIPT_BYTES) return "O comprovante deve ter no máximo 5 MB.";
  return null;
}

// Controles de gravação: só superadmin com payout:manage, fora de sessão de suporte.
export function canManagePayouts(subject: {
  role: string;
  supportSessionId?: string | null;
  support?: unknown;
  canManage: boolean;
}): boolean {
  return subject.role === "superadmin" && subject.canManage && !subject.supportSessionId && !subject.support;
}

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

const DAY_MS = 86_400_000;
const END_OF_DAY_MS = DAY_MS - 1_000; // o corte de uma data vale 23:59:59

// Última data (AAAA-MM-DD, São Paulo) cujo corte de 23:59:59 já passou da retenção: create_payout aceita até now() − prazo.
export function latestPayoutDate(retentionDays: number, now: Date = new Date()): string {
  const limit = new Date(now.getTime() - retentionDays * DAY_MS - END_OF_DAY_MS);
  return new Intl.DateTimeFormat("en-CA", { timeZone: SAO_PAULO_TZ }).format(limit);
}
