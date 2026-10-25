import { Card } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import type { TemplateRow } from "@/lib/notifications/queries";

import { CHANNEL_LABEL } from "./notification-logic";

export function TemplateList({ templates }: { templates: TemplateRow[] }) {
  if (templates.length === 0) return <p className="text-sm text-muted-foreground">Nenhum template ativo.</p>;
  return (
    <Card className="overflow-hidden">
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Chave</TableHead>
          <TableHead>Canal</TableHead>
          <TableHead>Versão</TableHead>
          <TableHead>Template WhatsApp</TableHead>
          <TableHead>Parâmetros</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {templates.map((t) => (
          <TableRow key={`${t.key}-${t.channel}-${t.version}`}>
            <TableCell className="font-mono text-xs">{t.key}</TableCell>
            <TableCell>{CHANNEL_LABEL[t.channel]}</TableCell>
            <TableCell>{t.version}</TableCell>
            <TableCell className="font-mono text-xs">
              {t.waTemplateName ? `${t.waTemplateName} (${t.waLanguage ?? "—"})` : "—"}
            </TableCell>
            <TableCell className="font-mono text-xs">{t.params.length ? t.params.join(", ") : "—"}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
    </Card>
  );
}
