import { Fragment, type ReactNode } from "react";

import type { FullSection, SectionPart } from "@/types/consultation-view";

import { PdfTable } from "../table";
import { addressLine, asTable, hasNested } from "./cells";
import { GenericPart, SectionTitle } from "./shared";

const EMAILS_PART = "E-mails";
const ADDRESSES_PART = "Outros endereços";
const EMPTY_TEXTS = ["Nenhum", "—"];

// Uma linha por e-mail (o motor genérico junta todos num texto só). null: sai pelo motor genérico.
function emailsTable(part: SectionPart): ReactNode | null {
  if (part.value.kind !== "text" || EMPTY_TEXTS.includes(part.value.text)) return null;
  const rows = part.value.text.split(", ").map((email) => ({ cells: [email] }));
  return <PdfTable title={part.title ?? undefined} columns={[{ label: "E-mail", type: "text" }]} rows={rows} />;
}

// Uma linha por endereço.
function addressesTable(part: SectionPart): ReactNode | null {
  const table = asTable(part, []);
  if (!table || hasNested(table) || table.rows.length === 0) return null;
  const rows = table.rows.map((_, r) => ({ cells: [addressLine(table, r)] }));
  return <PdfTable title={part.title ?? undefined} columns={[{ label: "Endereço", type: "text" }]} rows={rows} />;
}

export function renderContacts(section: FullSection): ReactNode | null {
  const curated = section.parts.map((part) =>
    part.title === EMAILS_PART ? emailsTable(part) : part.title === ADDRESSES_PART ? addressesTable(part) : null,
  );
  if (curated.every((node) => node === null)) return null;
  return (
    <>
      <SectionTitle title={section.title} />
      {section.parts.map((part, i) => (
        <Fragment key={i}>{curated[i] ?? <GenericPart part={part} />}</Fragment>
      ))}
    </>
  );
}
