import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { Suspense } from "react";

import { LoginForm } from "@/components/auth/login-form";
import { PublicShell } from "@/components/portal/public-shell";
import { Button } from "@/components/ui/button";
import { ScreenHeader } from "@/components/ui/screen-header";
import { resolveBureauSlug } from "@/lib/bureaus/public";

// Reads the DB without cookies/headers: without this Next may cache a 404 for a new slug or a stale bureau name.
export const dynamic = "force-dynamic";

// Same generic title for existing and unknown slugs: no enumeration signal.
export const metadata = {
  title: "Rainha Cred",
};

// Entrada do Bureau: login e "Criar conta", sem catálogo (o catálogo fica na página /b/<slug>).
export default async function PublicBureauEntryPage({
  params,
  searchParams,
}: {
  params: { slug: string };
  searchParams: { next?: string | string[] };
}) {
  const resolved = await resolveBureauSlug(params.slug);
  if (resolved.kind === "redirect") {
    const next = typeof searchParams.next === "string" ? `?next=${encodeURIComponent(searchParams.next)}` : "";
    redirect(`/b/${resolved.slug}/entrar${next}`);
  }
  if (resolved.kind === "missing") notFound();
  const { bureau } = resolved;

  return (
    <PublicShell bureauName={bureau.name}>
      <div className="space-y-6">
        <ScreenHeader
          className="-mx-4 min-[375px]:-mx-5"
          title="Entrar"
          backHref={`/b/${bureau.slug}`}
          backLabel="Voltar para a página do Bureau"
        />
        <Suspense fallback={null}>
          <LoginForm withHeading={false} />
        </Suspense>
        <div className="space-y-3 border-t pt-6">
          <p className="text-center text-muted-foreground">Ainda não tem conta?</p>
          <Button asChild variant="outline" className="w-full">
            <Link href={`/b/${bureau.slug}/cadastro`}>Criar conta</Link>
          </Button>
        </div>
        <p className="text-center text-sm text-muted-foreground">
          Metodologia da Rainha Cred · 16 anos de mercado · mais de R$ 500 milhões em crédito aprovado
        </p>
      </div>
    </PublicShell>
  );
}
