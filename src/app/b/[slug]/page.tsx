import Link from "next/link";
import { notFound } from "next/navigation";

import { getPublicBureau } from "@/lib/bureaus/public";

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

  return (
    <main className="flex min-h-screen items-center justify-center px-4 py-10">
      <div className="w-full max-w-md space-y-4 text-center">
        <h1 className="text-2xl font-semibold">{bureau.name}</h1>
        <p className="text-muted-foreground">Cadastro em breve</p>
        <Link href="/login" className="inline-block font-medium underline underline-offset-4">
          Entrar
        </Link>
      </div>
    </main>
  );
}
