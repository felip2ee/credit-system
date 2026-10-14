import Link from "next/link";

import { PageHeader } from "@/components/layout/page-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { getRequiredSession } from "@/lib/auth/session";
import { listBureauMetrics } from "@/lib/bureaus/queries";

export const metadata = { title: "Bureaus" };

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
                <Badge variant={b.status === "active" ? "success" : "muted"}>
                  {b.status === "active" ? "Ativo" : "Inativo"}
                </Badge>
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
