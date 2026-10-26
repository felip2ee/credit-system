import Link from "next/link";
import { Banknote, Bell, Building2, FileText, HandCoins, Package } from "lucide-react";

import { PageHeader } from "@/components/layout/page-header";
import { BalanceCard } from "@/components/ui/balance-card";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { QuickAction, QuickActions } from "@/components/ui/quick-actions";
import { SectionHeader } from "@/components/ui/section-header";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { StatusBadge } from "@/components/ui/status-badge";
import { getRequiredSession } from "@/lib/auth/session";
import { listBureauMetrics } from "@/lib/bureaus/queries";

export const metadata = { title: "Bureaus" };

function BureauStatus({ status }: { status: string }) {
  return status === "active" ? (
    <StatusBadge tone="success" label="Ativo" />
  ) : (
    <StatusBadge tone="neutral" label="Inativo" />
  );
}

export default async function SuperadminPage() {
  const session = await getRequiredSession();
  const bureaus = await listBureauMetrics(session);

  const total = (pick: (b: (typeof bureaus)[number]) => number) => bureaus.reduce((sum, b) => sum + pick(b), 0);
  const stats = [
    { label: "Bureaus ativos", value: bureaus.filter((b) => b.status === "active").length },
    { label: "Equipe", value: total((b) => b.staffCount) },
    { label: "Titulares", value: total((b) => b.holderCount) },
    { label: "Dossiês", value: total((b) => b.dossierCount) },
  ];

  return (
    <div className="space-y-6">
      <PageHeader title="Bureaus" description="Bureaus da plataforma e contagens de uso">
        <Button asChild>
          <Link href="/superadmin/bureaus/new">Novo Bureau</Link>
        </Button>
      </PageHeader>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <BalanceCard
          label="Consultas nos últimos 30 dias"
          value={String(total((b) => b.consultations30d))}
          hint={`${total((b) => b.consultationCount)} consultas no total`}
        />
        <div className="grid grid-cols-2 gap-4 lg:col-span-2">
          {stats.map((st) => (
            <Card key={st.label} className="flex flex-col justify-center p-5">
              <p className="text-3xl font-bold tabular-nums">{st.value}</p>
              <p className="text-base text-muted-foreground">{st.label}</p>
            </Card>
          ))}
        </div>
      </div>

      <section className="space-y-3">
        <SectionHeader title="Ações rápidas" />
        <Card className="p-5">
          <QuickActions className="sm:grid-cols-6">
            <QuickAction href="/superadmin/bureaus/new" label="Novo Bureau" icon={Building2} active />
            <QuickAction href="/superadmin/products" label="Produtos" icon={Package} />
            <QuickAction href="/superadmin/payouts" label="Repasses" icon={Banknote} />
            <QuickAction href="/superadmin/saques" label="Saques" icon={HandCoins} />
            <QuickAction href="/superadmin/nfse" label="NFS-e" icon={FileText} />
            <QuickAction href="/superadmin/notifications" label="Notificações" icon={Bell} />
          </QuickActions>
        </Card>
      </section>

      <SectionHeader title="Todos os Bureaus" />
      {/* Celular: um cartão por Bureau, número grande + rótulo. */}
      <ul className="space-y-4 md:hidden">
        {bureaus.map((b) => (
          <li key={b.bureauId} className="space-y-4 rounded-card border border-border bg-card p-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <Link className="inline-flex min-h-11 items-center text-lg font-bold hover:underline" href={`/superadmin/bureaus/${b.bureauId}`}>
                {b.name}
              </Link>
              <BureauStatus status={b.status} />
            </div>
            <dl className="grid grid-cols-2 gap-4">
              {[
                ["Equipe", b.staffCount],
                ["Titulares", b.holderCount],
                ["Dossiês", b.dossierCount],
                ["Consultas", b.consultationCount],
                ["Consultas (30d)", b.consultations30d],
              ].map(([label, value]) => (
                <div key={label}>
                  <dd className="text-3xl font-bold tabular-nums">{value}</dd>
                  <dt className="text-sm text-muted-foreground">{label}</dt>
                </div>
              ))}
            </dl>
          </li>
        ))}
        {bureaus.length === 0 && <li className="text-center text-muted-foreground">Nenhum Bureau cadastrado.</li>}
      </ul>
      <Card className="hidden overflow-hidden md:block">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Nome</TableHead>
            <TableHead>Slug</TableHead>
            <TableHead>Status</TableHead>
            <TableHead className="text-right">Equipe</TableHead>
            <TableHead className="text-right">Titulares</TableHead>
            <TableHead className="text-right">Dossiês</TableHead>
            <TableHead className="text-right">Consultas</TableHead>
            <TableHead className="text-right">Consultas (30d)</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {bureaus.map((b) => (
            <TableRow key={b.bureauId}>
              <TableCell>
                <Link className="font-medium hover:underline" href={`/superadmin/bureaus/${b.bureauId}`}>
                  {b.name}
                </Link>
              </TableCell>
              <TableCell>{b.slug}</TableCell>
              <TableCell>
                <BureauStatus status={b.status} />
              </TableCell>
              <TableCell className="text-right tabular-nums">{b.staffCount}</TableCell>
              <TableCell className="text-right tabular-nums">{b.holderCount}</TableCell>
              <TableCell className="text-right tabular-nums">{b.dossierCount}</TableCell>
              <TableCell className="text-right tabular-nums">{b.consultationCount}</TableCell>
              <TableCell className="text-right tabular-nums">{b.consultations30d}</TableCell>
            </TableRow>
          ))}
          {bureaus.length === 0 && (
            <TableRow>
              <TableCell colSpan={8} className="text-center text-muted-foreground">
                Nenhum Bureau cadastrado.
              </TableCell>
            </TableRow>
          )}
        </TableBody>
      </Table>
      </Card>
    </div>
  );
}
