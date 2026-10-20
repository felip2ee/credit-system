import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import type { GenericValue } from "@/types/consultation-view";

// Renderiza qualquer GenericValue; valores já vêm mascarados e formatados do view-model.
export function GenericValueView({ value }: { value: GenericValue }) {
  switch (value.kind) {
    case "text":
      return <p className="text-sm">{value.text}</p>;
    case "json":
      return <pre className="overflow-x-auto whitespace-pre-wrap break-words rounded-md bg-muted p-3 text-xs">{value.text}</pre>;
    case "fields":
      return (
        <dl className="grid grid-cols-1 gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
          {value.fields.map((f) => (
            <div key={f.key} className="min-w-0">
              <dt className="text-xs text-muted-foreground">{f.label}</dt>
              <dd className="break-words">
                <GenericValueView value={f.value} />
              </dd>
            </div>
          ))}
        </dl>
      );
    case "table":
      return (
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                {value.columns.map((c) => (
                  <TableHead key={c.key}>{c.label}</TableHead>
                ))}
              </TableRow>
            </TableHeader>
            <TableBody>
              {value.rows.map((row, i) => (
                // linhas estáticas, sem id próprio: índice é estável
                <TableRow key={i}>
                  {row.map((cell, j) => (
                    <TableCell key={value.columns[j]?.key ?? j}>{cell}</TableCell>
                  ))}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      );
  }
}
