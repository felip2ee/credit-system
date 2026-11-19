import { redirect } from "next/navigation";

import { PageHeader } from "@/components/layout/page-header";
import { CouponsList } from "@/components/settings/coupons/coupons-list";
import { getRequiredSession } from "@/lib/auth/session";
import { listCoupons } from "@/lib/coupons/queries";
import { hasPermission } from "@/lib/db/permissions";

export default async function CouponsPage() {
  const session = await getRequiredSession().catch(() => redirect("/login"));
  if (!hasPermission(session, "coupons:read")) redirect("/");

  const coupons = await listCoupons(session);

  return (
    <div>
      <PageHeader title="Cupons" description="Descontos que seus clientes usam ao pedir um dossiê" />
      <CouponsList coupons={coupons} />
    </div>
  );
}
