import { notFound } from "next/navigation";

import { ScrSelfAuthorizeForm } from "@/components/scr/scr-self-authorize-form";
import { getScrSelfAuthorizationByToken } from "@/actions/scr-self";
import { formatDate } from "@/lib/utils";

export const metadata = {
  title: "Autorização consulta SCR — Reino do Crédito",
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
    <main className="min-h-screen bg-[#0B5F59] px-4 py-10">
      <div className="mx-auto max-w-3xl overflow-hidden rounded-xl bg-white shadow-lg">
        <div className="bg-[#0B5F59] px-8 py-7 text-center">
          <div className="text-2xl font-bold tracking-wide text-white">
            Eliane Moreira
          </div>
          <div className="mt-1 text-[11px] font-medium uppercase tracking-[0.3em] text-[#C9A24B]">
            Rainha do Crédito
          </div>
        </div>
        <div className="bg-[#0E8C84] px-8 py-3.5 text-center">
          <h1 className="text-sm font-semibold uppercase tracking-wide text-white">
            Autorização de consulta SCR
          </h1>
        </div>

        <div className="space-y-4 px-8 py-6 text-sm leading-relaxed text-foreground">
          {paragraphs.map((p, i) => (
            <p key={i} className={i === 0 ? "" : "text-[13px]"}>
              {p}
            </p>
          ))}
        </div>

        <div className="border-t px-8 py-6">
          {alreadyAuthorized ? (
            <div className="rounded-md border border-emerald-200 bg-emerald-50 p-4 text-sm text-emerald-800">
              Esta autorização já foi concedida
              {data.expiresAt
                ? ` e é válida até ${formatDate(data.expiresAt)}.`
                : "."}
            </div>
          ) : refused ? (
            <div className="rounded-md border bg-muted p-4 text-sm text-muted-foreground">
              Esta autorização foi recusada.
            </div>
          ) : (
            <ScrSelfAuthorizeForm token={params.token} />
          )}
        </div>
      </div>
    </main>
  );
}
