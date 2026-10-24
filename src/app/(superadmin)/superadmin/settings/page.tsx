import Link from "next/link";

import { PageHeader } from "@/components/layout/page-header";
import { Card, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

export const metadata = { title: "Configurações" };

const SECTIONS = [
  { href: "/superadmin/settings/prompts", title: "Prompts da IA", description: "System prompts dos analisadores de crédito" },
  { href: "/superadmin/settings/scr", title: "Termo SCR", description: "Termo de consentimento da autogestão de SCR" },
  { href: "/superadmin/settings/afiliados", title: "Afiliados", description: "Carência da comissão e taxa de saque" },
];

export default function SuperadminSettingsPage() {
  return (
    <div className="space-y-6">
      <PageHeader title="Configurações" description="Regras globais, válidas para todos os Bureaus" />
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {SECTIONS.map((s) => (
          <Link key={s.href} href={s.href}>
            <Card className="h-full transition-colors hover:bg-muted/50">
              <CardHeader>
                <CardTitle className="text-lg">{s.title}</CardTitle>
                <CardDescription>{s.description}</CardDescription>
              </CardHeader>
            </Card>
          </Link>
        ))}
      </div>
    </div>
  );
}
