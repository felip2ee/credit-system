import Link from "next/link";

import { PageHeader } from "@/components/layout/page-header";
import { Button } from "@/components/ui/button";
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

  return (
    <div className="space-y-6">
      <PageHeader title="Bureaus" description="Bureaus da plataforma e contagens de uso">
        <Button asChild>
          <Link href="/superadmin/bureaus/new">Novo Bureau</Link>
        </Button>
      </PageHeader>
      {/* Celular: um cartão por Bureau, número grande + rótulo. */}
      <ul className="space-y-4 md:hidden">
        {bureaus.map((b) => (
          <li key={b.bureauId} className="space-y-4 rounded-lg border-2 bg-card p-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <Link className="text-lg font-bold hover:underline" href={`/superadmin/bureaus/${b.bureauId}`}>
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
                  <dd className="text-3xl font-bold">{value}</dd>
                  <dt className="text-sm text-muted-foreground">{label}</dt>
                </div>
              ))}
            </dl>
          </li>
        ))}
        {bureaus.length === 0 && <li className="text-center text-muted-foreground">Nenhum Bureau cadastrado.</li>}
      </ul>
      <Table className="hidden md:table">
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
              <TableCell className="text-right">{b.staffCount}</TableCell>
              <TableCell className="text-right">{b.holderCount}</TableCell>
              <TableCell className="text-right">{b.dossierCount}</TableCell>
              <TableCell className="text-right">{b.consultationCount}</TableCell>
              <TableCell className="text-right">{b.consultations30d}</TableCell>
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
    </div>
  );
}
