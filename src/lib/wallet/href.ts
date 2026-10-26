// Link da Carteira com os parâmetros dados; valor vazio sai da URL.
export function walletHref(params: Record<string, string | null | undefined>): string {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v) qs.set(k, v);
  const s = qs.toString();
  return `/settings/wallet${s ? `?${s}` : ""}`;
}
