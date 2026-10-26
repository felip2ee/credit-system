import { Coins, Users } from "lucide-react";

import { Card } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { StatusBadge } from "@/components/ui/status-badge";
import { ListRow } from "@/components/ui/list-row";
import { SectionHeader } from "@/components/ui/section-header";
import type { AffiliateCommissionRow, AffiliateReferralRow } from "@/lib/affiliates/types";
import { statusInfo } from "@/lib/ui/status";
import { formatCurrency, formatDateSP } from "@/lib/utils";

import { commissionStatusLabel } from "./affiliate-rules";

interface CommissionTablesProps {
  referrals: AffiliateReferralRow[];
  commissions: AffiliateCommissionRow[];
}

export function CommissionTables({ referrals, commissions }: CommissionTablesProps) {
  return (
    <>
      <section className="space-y-3">
        <SectionHeader title="Indicados" />
        <Card>
          {referrals.length === 0 ? (
            <EmptyState icon={Users} title="Ninguém se cadastrou pelo seu link ainda" description="Envie seu link de indicação para começar." />
          ) : (
            <ul className="divide-y divide-border">
              {referrals.map((r, index) => (
                <li key={`${r.createdAt}-${index}`}>
                  <ListRow
                    icon={Users}
                    title={r.name}
                    subtitle={`Cadastro em ${formatDateSP(r.createdAt)} · total gasto`}
                    value={formatCurrency(Number(r.totalSpent))}
                  />
                </li>
              ))}
            </ul>
          )}
        </Card>
      </section>
      <section className="space-y-3">
        <SectionHeader title="Comissões" />
        <Card>
          {commissions.length === 0 ? (
            <EmptyState icon={Coins} title="Você ainda não tem comissões" description="Elas aparecem quando um indicado fizer um pedido." />
          ) : (
            <ul className="divide-y divide-border">
              {commissions.map((c, index) => (
                <li key={`${c.createdAt}-${index}`}>
                  <ListRow
                    icon={Coins}
                    title={c.referredName}
                    subtitle={
                      <span className="block space-y-1">
                        <span className="block">
                          {c.productName} · {formatDateSP(c.createdAt)} · pedido {formatCurrency(Number(c.orderValue))}
                        </span>
                        <StatusBadge tone={statusInfo("commission", c.status, "client").tone} label={commissionStatusLabel(c.status, c.releaseAt)} />
                      </span>
                    }
                    value={formatCurrency(Number(c.amount))}
                  />
                </li>
              ))}
            </ul>
          )}
        </Card>
      </section>
    </>
  );
}
