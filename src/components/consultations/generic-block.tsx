import { Fragment } from "react";

import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import type { GenericValue } from "@/types/consultation-view";

// Renderiza qualquer GenericValue; valores já vêm mascarados e formatados do view-model.
export function GenericValueView({ value }: { value: GenericValue }) {
  switch (value.kind) {
    case "text":
      return <p className="text-sm">{value.text}</p>;
    case "json":
      return <pre className="overflow-x-auto whitespace-pre-wrap break-words rounded-md bg-muted p-3 text-sm">{value.text}</pre>;
    case "fields":
      return (
        <dl className="grid grid-cols-1 gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
          {value.fields.map((f) => (
            <div key={f.key} className="min-w-0">
              <dt className="text-sm text-muted-foreground">{f.label}</dt>
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
                <Fragment key={i}>
                  <TableRow>
                    {row.cells.map((cell, j) => (
                      <TableCell key={value.columns[j]?.key ?? j}>{cell}</TableCell>
                    ))}
                  </TableRow>
                  {row.nested.length > 0 && (
                    <TableRow className="hover:bg-transparent">
                      <TableCell colSpan={Math.max(value.columns.length, 1)} className="space-y-3 border-l pl-4">
                        {row.nested.map((n) => (
                          <div key={n.label} className="space-y-1">
                            <p className="text-sm font-medium text-muted-foreground">{n.label}</p>
                            <GenericValueView value={n.value} />
                          </div>
                        ))}
                      </TableCell>
                    </TableRow>
                  )}
                </Fragment>
              ))}
            </TableBody>
          </Table>
        </div>
      );
  }
}
