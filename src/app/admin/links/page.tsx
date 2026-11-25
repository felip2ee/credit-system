import { redirect } from "next/navigation";

import { PageHeader } from "@/components/layout/page-header";
import { CopyLinkButton } from "@/components/superadmin/copy-link-button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { getRequiredSession } from "@/lib/auth/session";
import { getBureau } from "@/lib/bureaus/queries";
import { config } from "@/lib/config";

export default async function AdminLinksPage() {
  const session = await getRequiredSession().catch(() => redirect("/login"));
  if (!session.bureauId) redirect("/login");

  const bureau = await getBureau(session, session.bureauId);
  const base = config.betterAuthUrl.replace(/\/$/, "");
  const links = bureau
    ? [
        { title: "Link público do Bureau", hint: "Página de apresentação do seu Bureau. Divulgue em redes sociais e anúncios para atrair clientes.", url: `${base}/b/${bureau.slug}` },
        { title: "Link de cadastro", hint: "Leva o cliente direto ao cadastro. Envie a quem já quer contratar.", url: `${base}/b/${bureau.slug}/cadastro` },
      ]
    : [];

  return (
    <div className="space-y-5">
      <PageHeader title="Links" description="Seus links de divulgação" />
      {links.length === 0 && <p className="text-sm text-muted-foreground">Bureau não encontrado.</p>}
      <div className="space-y-3">
        {links.map((l) => (
          <Card key={l.url}>
            <CardHeader className="pb-2">
              <CardTitle className="text-base">{l.title}</CardTitle>
              <p className="text-sm text-muted-foreground">{l.hint}</p>
            </CardHeader>
            <CardContent className="flex items-center gap-2">
              <a href={l.url} target="_blank" rel="noreferrer" className="min-w-0 flex-1 truncate text-sm font-medium underline-offset-2 hover:underline">
                {l.url}
              </a>
              <CopyLinkButton url={l.url} label={`Copiar ${l.title}`} />
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}
