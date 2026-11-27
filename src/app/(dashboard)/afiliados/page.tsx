import { redirect } from "next/navigation";
import { z } from "zod";

import { AffiliateEnabledCard } from "@/components/affiliates/affiliate-enabled-card";
import { BureauAffiliatesTable } from "@/components/affiliates/bureau-affiliates-table";
import { ClientLossTable } from "@/components/affiliates/ClientLossTable";
import { ReportFilters } from "@/components/affiliates/ReportFilters";
import { SplitReportTable } from "@/components/affiliates/SplitReportTable";
import { PageHeader } from "@/components/layout/page-header";
import { SectionHeader } from "@/components/ui/section-header";
import { isAffiliateEnabled } from "@/lib/affiliates/enabled";
import { getBureauDefaultPct, listBureauAffiliates } from "@/lib/affiliates/rates";
import { listBureauSplits, listClientLosses, parseReportRange } from "@/lib/affiliates/split-report";
import { getRequiredSession, sessionErrorPath } from "@/lib/auth/session";
import { hasPermission } from "@/lib/db/permissions";

export const metadata = { title: "Afiliados" };

const statusSchema = z.enum(["pending", "done", "refused", "refunded", "reversal_failed"]);

export default async function AffiliatesPage({ searchParams }: { searchParams: { de?: string; ate?: string; status?: string } }) {
  const session = await getRequiredSession().catch((err) => redirect(sessionErrorPath(err)));
  if (!hasPermission(session, "affiliates:read") || !session.bureauId) redirect("/");

  const enabled = await isAffiliateEnabled(session);
  const affiliates = enabled ? await listBureauAffiliates(session) : [];
  const defaultPct = await getBureauDefaultPct(session);

  // Repasses e prejuízo: só quem lê repasses do Bureau (bureau_admin). O RLS limita ao próprio Bureau.
  const showReport = hasPermission(session, "payout:read");
  const range = parseReportRange(searchParams);
  const status = statusSchema.safeParse(searchParams.status);
  const [splits, losses] = showReport
    ? await Promise.all([
        listBureauSplits(session, { ...range, status: status.success ? status.data : undefined }),
        listClientLosses(session, range),
      ])
    : [[], []];

  return (
    <div className="space-y-6">
      <PageHeader title="Afiliados" description="Quem indica clientes ao seu Bureau e a comissão paga a eles" />
      {hasPermission(session, "affiliate_settings:manage") && <AffiliateEnabledCard enabled={enabled} />}
      {enabled && <BureauAffiliatesTable defaultPct={defaultPct} affiliates={affiliates} />}
      {showReport && (
        <>
          <ReportFilters fromDate={range.fromDate} toDate={range.toDate} status={status.success ? status.data : undefined} />
          <section className="space-y-3">
            <SectionHeader title="Repasses da entrada de dinheiro" />
            <SplitReportTable rows={splits} />
          </section>
          <section className="space-y-3">
            <SectionHeader title="Estornos e chargebacks por cliente" />
            <ClientLossTable rows={losses} />
          </section>
        </>
      )}
    </div>
  );
}
