// Apoio dos testes de PDF: extrai o texto de um PDF com fontes TrueType embutidas ou com a Helvetica padrão.
import { inflateSync } from "node:zlib";

function inflateOrNull(raw: string): string | null {
  try {
    return inflateSync(Buffer.from(raw, "latin1")).toString("latin1");
  } catch {
    return null; // stream sem Flate (imagem)
  }
}

// Texto do PDF: fontes TrueType embutidas usam glifos; decodifica pelo CMap ToUnicode de cada fonte.
export function pdfText(pdf: Buffer): string {
  const raw = pdf.toString("latin1");
  const cmaps = new Map<string, Map<string, string>>();
  const fontToCmap = new Map<string, string>();
  const contents: string[] = [];
  for (const obj of Array.from(raw.matchAll(/(\d+) 0 obj([\s\S]*?)endobj/g))) {
    const [, id, body] = obj;
    const stream = body.match(/stream\r?\n([\s\S]*?)endstream/);
    const decoded = stream ? inflateOrNull(stream[1]) : null;
    const toUnicode = body.match(/\/ToUnicode (\d+) 0 R/);
    if (toUnicode) fontToCmap.set(id, toUnicode[1]);
    if (decoded?.includes("beginbfchar") || decoded?.includes("beginbfrange")) {
      const map = new Map<string, string>();
      for (const m of Array.from(decoded.matchAll(/<([0-9a-f]+)>\s*<([0-9a-f]+)>(?=\s*(?:<|endbf))/gi))) {
        map.set(m[1].toLowerCase(), Buffer.from(m[2], "hex").swap16().toString("utf16le"));
      }
      cmaps.set(id, map);
    } else if (decoded) contents.push(decoded);
  }
  const fontByName = new Map<string, string>();
  for (const m of Array.from(raw.matchAll(/\/(F\d+) (\d+) 0 R/g))) fontByName.set(m[1], m[2]);

  const lines: string[] = [];
  for (const stream of contents) {
    let map: Map<string, string> | undefined;
    for (const t of Array.from(stream.matchAll(/\/(F\d+) [\d.]+ Tf|\[([^\]]*)\]\s*TJ|<([0-9a-f]+)>\s*Tj/gi))) {
      if (t[1]) {
        map = cmaps.get(fontToCmap.get(fontByName.get(t[1]) ?? "") ?? "");
        continue;
      }
      const hexes = t[3] ? [t[3]] : Array.from(t[2].matchAll(/<([0-9a-f]*)>/gi)).map((h) => h[1]);
      // Fonte padrão (Helvetica) não tem ToUnicode: cada byte é um caractere Latin-1.
      const decode = (h: string): string =>
        map
          ? (h.match(/.{4}/g) ?? []).map((c) => map?.get(c.toLowerCase()) ?? "").join("")
          : Buffer.from(h, "hex").toString("latin1");
      lines.push(hexes.map(decode).join(""));
    }
  }
  return lines.join("\n");
}
