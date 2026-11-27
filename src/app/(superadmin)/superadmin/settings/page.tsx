import Link from "next/link";

import { PageHeader } from "@/components/layout/page-header";
import { Card, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

export const metadata = { title: "Configurações" };

const SECTIONS = [
  { href: "/superadmin/settings/afiliados", title: "Afiliados", description: "Carência da comissão e taxa de saque do programa de afiliados" },
  { href: "/superadmin/settings/comissao", title: "Comissão dos Bureaus", description: "% do preço bruto que o Bureau recebe em cada venda. Vale para todo Bureau que não tem uma % própria" },
  { href: "/superadmin/settings/prompts", title: "Prompts da IA", description: "System prompts dos analisadores de crédito" },
  { href: "/superadmin/settings/repasses", title: "Prazo dos repasses", description: "Quantos dias o valor a receber fica retido antes do repasse" },
  { href: "/superadmin/settings/scr", title: "Termo SCR", description: "Termo de consentimento da autogestão de SCR" },
  { href: "/superadmin/settings/socios", title: "Sócios", description: "walletId e % de cada sócio no split de toda cobrança" },
];

export default function SuperadminSettingsPage() {
  return (
    <div className="space-y-4">
      <PageHeader title="Configurações" description="Regras globais, válidas para todos os Bureaus" />
      <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {SECTIONS.map((s) => (
          <li key={s.href}>
            <Link href={s.href} className="block h-full rounded-card focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
              <Card className="h-full transition-colors hover:bg-accent">
                <CardHeader>
                  <CardTitle>{s.title}</CardTitle>
                  <CardDescription>{s.description}</CardDescription>
                </CardHeader>
              </Card>
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}
