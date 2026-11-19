import { Font } from "@react-pdf/renderer";

// Fontes embutidas do react-pdf: o zero liso da Helvetica não confunde valores.
export const PDF_FONT_FAMILY = "Helvetica";
export const PDF_FONT_FAMILY_BOLD = "Helvetica-Bold";

const MAX_TOKEN_PART = 16;

// Palavra curta fica inteira; token longo sem espaço (URL, número grande) quebra em partes que cabem na célula.
export function breakLongToken(word: string): string[] {
  if (word.length <= MAX_TOKEN_PART) return [word];
  const parts: string[] = [];
  for (let i = 0; i < word.length; i += MAX_TOKEN_PART) parts.push(word.slice(i, i + MAX_TOKEN_PART));
  return parts;
}

let registered = false;

// Idempotente. O padrão inglês de hifenização quebra palavras em português no meio; aqui só token longo quebra.
export function registerPdfFonts(): void {
  if (registered) return;
  Font.registerHyphenationCallback(breakLongToken);
  registered = true;
}
