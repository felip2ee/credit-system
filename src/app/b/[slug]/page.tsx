import Link from "next/link";
import { notFound } from "next/navigation";

import { getPublicBureau, getPublicCatalog } from "@/lib/bureaus/public";
import { formatCurrency } from "@/lib/utils";

// Reads the DB without cookies/headers: without this Next may cache a 404 for a new slug or a stale bureau name.
export const dynamic = "force-dynamic";

// Same generic title for existing and unknown slugs: no enumeration signal.
export const metadata = {
  title: "Reino do Crédito",
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
    <main className="flex min-h-screen items-center justify-center px-4 py-10">
      <div className="w-full max-w-md space-y-4 text-center">
        <h1 className="text-2xl font-semibold">{bureau.name}</h1>
        {catalog.length === 0 ? (
          <p className="text-muted-foreground">Catálogo em breve</p>
        ) : (
          <ul className="divide-y rounded-md border text-left">
            {catalog.map((item) => (
              <li key={item.code} className="flex justify-between gap-4 px-4 py-3">
                <span>{item.name}</span>
                <span className="font-medium">{formatCurrency(Number(item.salePrice))}</span>
              </li>
            ))}
          </ul>
        )}
        <div className="flex justify-center gap-6">
          <Link
            href={`/b/${bureau.slug}/cadastro`}
            className="inline-block font-medium underline underline-offset-4"
          >
            Criar conta
          </Link>
          <Link href="/login" className="inline-block font-medium underline underline-offset-4">
            Entrar
          </Link>
        </div>
      </div>
    </main>
  );
}
