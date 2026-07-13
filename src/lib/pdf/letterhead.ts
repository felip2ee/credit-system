import { readFileSync } from "node:fs";
import { join } from "node:path";

let cached: string | null = null;

// Timbrado usado como fundo (fixed) de todas as páginas dos PDFs.
export function letterheadDataUri(): string {
  if (cached) return cached;
  const buf = readFileSync(join(process.cwd(), "public", "letterhead.png"));
  cached = `data:image/png;base64,${buf.toString("base64")}`;
  return cached;
}
