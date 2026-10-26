import Link from "next/link";

import { WALLET_TAB_LABEL, type WalletTab } from "@/lib/wallet/tabs";
import { cn } from "@/lib/utils";

export function WalletTabs({ tabs, active }: { tabs: readonly WalletTab[]; active: WalletTab }) {
  if (tabs.length < 2) return null;
  return (
    <nav aria-label="Seções da carteira" className="flex gap-2 overflow-x-auto pb-1">
      {tabs.map((t) => (
        <Link
          key={t}
          href={`/settings/wallet?aba=${t}`}
          aria-current={t === active ? "page" : undefined}
          className={cn(
            "inline-flex min-h-11 shrink-0 items-center rounded-full border px-4 text-sm font-bold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
            t === active ? "border-transparent bg-primary text-primary-foreground" : "border-border bg-background hover:bg-muted",
          )}
        >
          {WALLET_TAB_LABEL[t]}
        </Link>
      ))}
    </nav>
  );
}
