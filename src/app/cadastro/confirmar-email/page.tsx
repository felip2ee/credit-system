import Link from "next/link";

import { PublicShell } from "@/components/portal/public-shell";
import { ConfirmEmailButton } from "@/components/register/confirm-email-button";
import { Button } from "@/components/ui/button";
import { AuthHeading } from "@/components/auth/auth-heading";
import { StatusBanner } from "@/components/ui/status-banner";
import { EMAIL_TOKEN_PATTERN } from "@/lib/validators/account";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Confirmar e-mail",
  robots: { index: false },
};

export default function ConfirmEmailPage({
  searchParams,
}: {
  searchParams: { token?: string | string[] };
}) {
  const token = typeof searchParams.token === "string" ? searchParams.token : "";
  const valid = EMAIL_TOKEN_PATTERN.test(token);

  return (
    <PublicShell>
      <section className="space-y-8">
        <AuthHeading title="Confirmar e-mail" />
        {valid ? (
          <ConfirmEmailButton token={token} />
        ) : (
          <div className="space-y-3">
            <StatusBanner tone="attention" title="Link inválido." description="Entre na sua conta para pedir um novo link." />
            <Button asChild size="lg" className="w-full">
              <Link href="/login">Entrar</Link>
            </Button>
          </div>
        )}
      </section>
    </PublicShell>
  );
}
