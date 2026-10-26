export type WalletTab = "online" | "balcao" | "extrato" | "receber";

export const WALLET_TAB_LABEL: Record<WalletTab, string> = {
  online: "Pedidos online",
  balcao: "Balcão",
  extrato: "Extrato total",
  receber: "A receber e saques",
};

const ORDER: readonly WalletTab[] = ["online", "balcao", "extrato", "receber"];

// Pedidos online e Extrato total sempre aparecem; Balcão e A receber dependem de permissão.
export function visibleWalletTabs(access: { payout: boolean; counter: boolean }): WalletTab[] {
  return ORDER.filter((t) => (t === "receber" ? access.payout : t === "balcao" ? access.counter : true));
}

// Valor fora da lista (ou aba sem permissão) cai em "online". O nome antigo "a-receber" vale como "receber".
export function parseWalletTab(raw: string | string[] | undefined, visible: readonly WalletTab[]): WalletTab {
  const value = raw === "a-receber" ? "receber" : raw;
  return visible.find((t) => t === value) ?? "online";
}
