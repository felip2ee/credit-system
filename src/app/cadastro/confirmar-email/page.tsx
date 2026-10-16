import Link from "next/link";

import { ConfirmEmailButton } from "@/components/register/confirm-email-button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
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
    <main className="flex min-h-screen items-center justify-center px-4 py-10">
      <Card className="w-full max-w-sm text-center">
        <CardHeader>
          <CardTitle className="text-2xl">Confirmar e-mail</CardTitle>
        </CardHeader>
        <CardContent>
          {valid ? (
            <ConfirmEmailButton token={token} />
          ) : (
            <div className="space-y-3">
              <p role="alert" className="text-sm text-destructive">Link inválido.</p>
              <Link href="/login" className="inline-block font-medium underline underline-offset-4">
                Entrar
              </Link>
            </div>
          )}
        </CardContent>
      </Card>
    </main>
  );
}
