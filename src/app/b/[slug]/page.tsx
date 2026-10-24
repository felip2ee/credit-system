import Link from "next/link";
import { notFound } from "next/navigation";
import { PackageOpen } from "lucide-react";

import { PublicShell } from "@/components/portal/public-shell";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { getPublicBureau, getPublicCatalog } from "@/lib/bureaus/public";
import { formatCurrency } from "@/lib/utils";

// Reads the DB without cookies/headers: without this Next may cache a 404 for a new slug or a stale bureau name.
export const dynamic = "force-dynamic";

// Same generic title for existing and unknown slugs: no enumeration signal.
export const metadata = {
  title: "Rainha Cred",
};

export default async function PublicBureauPage({
  params,
}: {
  params: { slug: string };
}) {
  const bureau = await getPublicBureau(params.slug);
  if (!bureau) notFound();
  const catalog = await getPublicCatalog(params.slug);

  return (
    <PublicShell bureauName={bureau.name}>
      <div className="space-y-6">
        {catalog.length === 0 ? (
          <EmptyState icon={PackageOpen} title="Catálogo em breve" description="Este Bureau ainda não colocou pesquisas à venda." />
        ) : (
          <ul className="divide-y rounded-md border-2 bg-background text-left">
            {catalog.map((item) => (
              <li key={item.code} className="flex flex-col gap-1 px-4 py-4">
                <span className="font-bold">{item.name}</span>
                <span>
                  {Number(item.salePricePerPartner) > 0
                    ? `a partir de ${formatCurrency(Number(item.salePrice))} + ${formatCurrency(Number(item.salePricePerPartner))} por sócio`
                    : formatCurrency(Number(item.salePrice))}
                </span>
              </li>
            ))}
          </ul>
        )}
        <div className="flex flex-col gap-3">
          <Button asChild size="lg">
            <Link href={`/b/${bureau.slug}/cadastro`}>Criar conta</Link>
          </Button>
          <Button asChild size="lg" variant="outline">
            <Link href="/login">Já tenho conta: entrar</Link>
          </Button>
        </div>
      </div>
    </PublicShell>
  );
}
