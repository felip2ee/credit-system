import Link from "next/link";

import { PublicShell } from "@/components/portal/public-shell";
import { ConfirmEmailButton } from "@/components/register/confirm-email-button";
import { Button } from "@/components/ui/button";
import { ScreenHeader } from "@/components/ui/screen-header";
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
      <section className="space-y-6">
        <ScreenHeader className="-mx-4 min-[375px]:-mx-5" title="Confirmar e-mail" backHref="/login" backLabel="Voltar para entrar" />
        {valid ? (
          <ConfirmEmailButton token={token} />
        ) : (
          <div className="space-y-3">
            <StatusBanner tone="attention" title="Link inválido." description="O link é inválido ou expirou. A confirmação de e-mail não é mais necessária: use o portal normalmente." />
            <Button asChild variant="cta" className="w-full">
              <Link href="/login">Entrar</Link>
            </Button>
          </div>
        )}
      </section>
    </PublicShell>
  );
}
