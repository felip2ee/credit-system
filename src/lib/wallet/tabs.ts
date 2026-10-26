export type WalletTab = "extrato" | "a-receber" | "balcao";

export const WALLET_TAB_LABEL: Record<WalletTab, string> = {
  extrato: "Extrato",
  "a-receber": "A receber",
  balcao: "Pagamentos de balcão",
};

const ORDER: readonly WalletTab[] = ["extrato", "a-receber", "balcao"];

// Extrato sempre aparece; as outras abas dependem de permissão.
export function visibleWalletTabs(access: { payout: boolean; counter: boolean }): WalletTab[] {
  return ORDER.filter((t) => t === "extrato" || (t === "a-receber" ? access.payout : access.counter));
}

// Valor fora da lista (ou aba sem permissão) cai em "extrato".
export function parseWalletTab(raw: string | string[] | undefined, visible: readonly WalletTab[]): WalletTab {
  return visible.find((t) => t === raw) ?? "extrato";
}
