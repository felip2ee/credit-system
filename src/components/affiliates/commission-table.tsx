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

function commissionDetails(c: AffiliateCommissionRow): string {
  const base = c.baseValue === null ? "" : `${c.fromRecharge ? "recarga" : "pedido"} ${formatCurrency(Number(c.baseValue))}`;
  // O valor da linha asaas é estimado: o Asaas aplica a % sobre o valor líquido.
  const estimate = c.paidBy === "asaas" ? "comissão aproximada" : "";
  return [c.productName, formatDateSP(c.createdAt), base, estimate].filter(Boolean).join(" · ");
}

function commissionBadge(c: AffiliateCommissionRow) {
  if (c.paidBy === "asaas") {
    const { tone, label } = statusInfo("asaasCommission", c.status, "client");
    return { tone, label };
  }
  return { tone: statusInfo("commission", c.status, "client").tone, label: commissionStatusLabel(c.status, c.releaseAt) };
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
                    subtitle={`Cadastro em ${formatDateSP(r.createdAt)}${Number(r.recharged) > 0 ? " · recargas com comissão" : ""}`}
                    value={Number(r.recharged) > 0 ? formatCurrency(Number(r.recharged)) : undefined}
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
            <EmptyState icon={Coins} title="Você ainda não tem comissões" description="Elas aparecem quando um indicado fizer uma recarga." />
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
                          {commissionDetails(c)}
                        </span>
                        <StatusBadge {...commissionBadge(c)} />
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
