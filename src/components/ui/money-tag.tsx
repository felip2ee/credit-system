import type { ReactNode } from "react";

import { cn } from "@/lib/utils";

export type MoneyTone = "in" | "out" | "neutral";

// Texto e ícone de cada tipo de lançamento; o fundo vem de MONEY_TAG_CLASS.
export const MONEY_TEXT_CLASS: Record<MoneyTone, string> = {
  in: "text-money-in-fg",
  out: "text-money-out-fg",
  neutral: "text-money-void-fg",
};
const MONEY_TAG_CLASS: Record<MoneyTone, string> = {
  in: "bg-money-in-bg",
  out: "bg-money-out-bg",
  neutral: "bg-money-void-bg",
};

// Valor do extrato em pílula: verde claro (entrada), vermelho claro (gasto), cinza (cancelado ou sem efeito no saldo).
export function MoneyTag({ tone, struck = false, children }: { tone: MoneyTone; struck?: boolean; children: ReactNode }) {
  return (
    <span className={cn("inline-block rounded-full px-3 py-1", MONEY_TAG_CLASS[tone], MONEY_TEXT_CLASS[tone], struck && "line-through")}>
      {children}
    </span>
  );
}
