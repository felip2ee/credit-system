// Política da chave de idempotência do checkout (pura, sem DOM). A chave vive só
// em memória (useRef): nunca vai para localStorage.

export type KeyHolder = { key: string; fingerprint: string } | null;

/** "rejected": o servidor recusou ({ error }), nada foi criado. "succeeded": QR ou cartão aceito. "unknown": falha de rede ou cobrança reaproveitada. */
export type SubmitOutcome = "rejected" | "succeeded" | "unknown";

export function checkoutFingerprint(p: { amount: string; method: string; installments: number; kind: string }): string {
  return JSON.stringify([p.amount.trim(), p.method, p.installments, p.kind]);
}

/** Reusa a chave se for o mesmo pagamento; senão gera uma nova. */
export function acquireKey(holder: KeyHolder, fingerprint: string, generate: () => string): { key: string; holder: NonNullable<KeyHolder> } {
  const next = holder && holder.fingerprint === fingerprint ? holder : { key: generate(), fingerprint };
  return { key: next.key, holder: next };
}

/** Só uma resposta definitiva descarta a chave; o estado desconhecido a mantém para o retry. */
export function settleKey(holder: KeyHolder, outcome: SubmitOutcome): KeyHolder {
  return outcome === "unknown" ? holder : null;
}
