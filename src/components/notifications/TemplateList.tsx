import { Card } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import type { TemplateRow } from "@/lib/notifications/queries";

import { CHANNEL_LABEL } from "./notification-logic";

export function TemplateList({ templates }: { templates: TemplateRow[] }) {
  if (templates.length === 0) return <p className="text-sm text-muted-foreground">Nenhum template ativo.</p>;
  return (
    <>
      <ul className="space-y-3 md:hidden" aria-label="Templates ativos">
        {templates.map((t) => (
          <li key={`${t.key}-${t.channel}-${t.version}`}>
            <Card className="space-y-2 p-4">
              <p className="break-all font-mono text-sm font-bold">{t.key}</p>
              <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
                <dt className="text-muted-foreground">Canal</dt>
                <dd>{CHANNEL_LABEL[t.channel]}</dd>
                <dt className="text-muted-foreground">Versão</dt>
                <dd>{t.version}</dd>
                <dt className="text-muted-foreground">Template WhatsApp</dt>
                <dd className="break-all font-mono text-xs">
                  {t.waTemplateName ? `${t.waTemplateName} (${t.waLanguage ?? "—"})` : "—"}
                </dd>
                <dt className="text-muted-foreground">Parâmetros</dt>
                <dd className="break-all font-mono text-xs">{t.params.length ? t.params.join(", ") : "—"}</dd>
              </dl>
            </Card>
          </li>
        ))}
      </ul>
      <Card className="hidden overflow-hidden md:block">
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
    </>
  );
}
