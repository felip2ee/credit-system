import { join } from "node:path";
import { Font } from "@react-pdf/renderer";

export const PDF_FONT_FAMILY = "Atkinson";

const FONT_DIR = join(process.cwd(), "src", "lib", "pdf", "fonts");
let registered = false;

// Atkinson Hyperlegible (OFL, ver OFL.txt): 400 e 700. Idempotente.
export function registerPdfFonts(): void {
  if (registered) return;
  Font.register({
    family: PDF_FONT_FAMILY,
    fonts: [
      { src: join(FONT_DIR, "AtkinsonHyperlegible-Regular.ttf"), fontWeight: 400 },
      { src: join(FONT_DIR, "AtkinsonHyperlegible-Bold.ttf"), fontWeight: 700 },
    ],
  });
  // O padrão inglês de hifenização quebra palavras em português (e nomes) no meio.
  Font.registerHyphenationCallback((word) => [word]);
  registered = true;
}
