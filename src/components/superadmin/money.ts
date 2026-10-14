/** Só para exibição; a regra de dinheiro nunca usa este número. */
export function formatBRL(value: string): string {
  return new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" }).format(Number(value));
}
