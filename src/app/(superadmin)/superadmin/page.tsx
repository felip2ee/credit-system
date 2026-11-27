import Link from "next/link";

import { PageHeader } from "@/components/layout/page-header";
import { BalanceCard } from "@/components/ui/balance-card";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
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
import { CopyLinkButton } from "@/components/superadmin/copy-link-button";
import { config } from "@/lib/config";
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
  const baseUrl = config.betterAuthUrl.replace(/\/$/, "");

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
            <Card key={st.label} className="flex flex-col justify-center p-4">
              <p className="text-2xl font-bold tabular-nums">{st.value}</p>
              <p className="text-base text-muted-foreground">{st.label}</p>
            </Card>
          ))}
        </div>
      </div>

      <SectionHeader title="Todos os Bureaus" />
      {/* Celular: um cartão por Bureau, número grande + rótulo. */}
      <ul className="space-y-4 md:hidden">
        {bureaus.map((b) => (
          <li key={b.bureauId} className="space-y-4 rounded-card border border-border bg-card p-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <Link className="inline-flex min-h-11 items-center text-base font-bold hover:underline" href={`/superadmin/bureaus/${b.bureauId}`}>
                {b.name}
              </Link>
              <BureauStatus status={b.status} />
            </div>
            <div className="flex flex-wrap items-center gap-2 text-sm">
              <span className="break-all text-muted-foreground">/b/{b.slug}</span>
              <CopyLinkButton url={`${baseUrl}/b/${b.slug}`} />
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
                  <dd className="text-2xl font-bold tabular-nums">{value}</dd>
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
            <TableHead>Link público</TableHead>
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
              <TableCell>
                <div className="flex items-center gap-2">
                  <span>/b/{b.slug}</span>
                  <CopyLinkButton url={`${baseUrl}/b/${b.slug}`} />
                </div>
              </TableCell>
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
