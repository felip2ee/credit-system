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
