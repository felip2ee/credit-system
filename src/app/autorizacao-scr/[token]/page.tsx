import { notFound } from "next/navigation";

import { PublicShell } from "@/components/portal/public-shell";
import { ScrSelfAuthorizeForm } from "@/components/scr/scr-self-authorize-form";
import { getScrSelfAuthorizationByToken } from "@/actions/scr-self";
import { Card, CardContent } from "@/components/ui/card";
import { StatusBanner } from "@/components/ui/status-banner";
import { formatDate } from "@/lib/utils";

export const metadata = {
  title: "Autorização consulta SCR — Rainha Cred",
  // O token está na URL: sem indexação e sem Referer.
  robots: { index: false, follow: false },
  referrer: "no-referrer" as const,
};

export default async function ScrAuthorizationPage({
  params,
}: {
  params: { token: string };
}) {
  const data = await getScrSelfAuthorizationByToken(params.token);
  if (!data) notFound();

  const paragraphs = data.consentText
    .split("\n\n")
    .map((p) => p.trim())
    .filter(Boolean);

  const alreadyAuthorized = data.status === "authorized";
  const refused = data.status === "not_authorized";

  return (
    <PublicShell width="3xl">
      <div className="space-y-6">
        <h1 className="text-center font-bold">Autorização de consulta SCR</h1>
        <Card>
          <CardContent className="space-y-4 pt-4 leading-relaxed">
            {paragraphs.map((p, i) => (
              <p key={i}>{p}</p>
            ))}
          </CardContent>
        </Card>
        {alreadyAuthorized ? (
          <StatusBanner
            tone="success"
            title="Esta autorização já foi concedida"
            description={data.expiresAt ? `Ela é válida até ${formatDate(data.expiresAt)}.` : undefined}
          />
        ) : refused ? (
          <StatusBanner tone="neutral" title="Esta autorização foi recusada." description="Nenhuma consulta será realizada." />
        ) : (
          <Card>
            <CardContent className="pt-4">
              <ScrSelfAuthorizeForm token={params.token} />
            </CardContent>
          </Card>
        )}
      </div>
    </PublicShell>
  );
}
