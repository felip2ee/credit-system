import { redirect } from "next/navigation";
import { z } from "zod";

import { ReportFilters } from "@/components/affiliates/ReportFilters";
import { SplitReportTable } from "@/components/affiliates/SplitReportTable";
import { PageHeader } from "@/components/layout/page-header";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { getPartnerSplitTotal, listBureauSplits, parseReportRange } from "@/lib/affiliates/split-report";
import { getRequiredSession } from "@/lib/auth/session";
import { hasPermission } from "@/lib/db/permissions";
import { formatCurrency } from "@/lib/utils";

export const metadata = { title: "Split da entrada" };

const statusSchema = z.enum(["pending", "done", "refused", "refunded", "reversal_failed"]);

export default async function SplitReportPage({ searchParams }: { searchParams: { de?: string; ate?: string; status?: string } }) {
  const session = await getRequiredSession().catch(() => redirect("/login"));
  if (!hasPermission(session, "partner:manage") || session.supportSessionId) redirect("/");

  const range = parseReportRange(searchParams);
  const status = statusSchema.safeParse(searchParams.status);
  const [splits, partnersCents] = await Promise.all([
    listBureauSplits(session, { ...range, status: status.success ? status.data : undefined }),
    getPartnerSplitTotal(session, range),
  ]);

  return (
    <div className="space-y-6">
      <PageHeader title="Split da entrada" description="Repasses de todos os Bureaus e o total que foi para os sócios" />
      <Card>
        <CardHeader>
          <CardTitle className="text-lg">Total dos sócios no período</CardTitle>
          <CardDescription>Pendente, repassado ou sem reversão. Recusado e estornado voltaram para a plataforma.</CardDescription>
        </CardHeader>
        <CardContent>
          <p className="text-2xl font-semibold">{formatCurrency(partnersCents / 100)}</p>
        </CardContent>
      </Card>
      <ReportFilters fromDate={range.fromDate} toDate={range.toDate} status={status.success ? status.data : undefined} />
      <SplitReportTable rows={splits} showBureau />
    </div>
  );
}
