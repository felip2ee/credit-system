import type { MapaMental } from "@/types/ai";

export type MapaNodeKind = "centro" | "ramo" | "no" | "evitar";

export interface MapaNode {
  id: string;
  kind: MapaNodeKind;
  x: number;
  y: number;
  w: number;
  h: number;
  lines: string[];
  prazo?: string;
  dono?: string;
}

export interface MapaEdge {
  from: string;
  to: string;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

export interface MapaLayout {
  width: number;
  height: number;
  nodes: MapaNode[];
  edges: MapaEdge[];
  /** Y where each band starts (band 0 = centro + first row of ramos; then one per row). The PDF cuts the map here. */
  bandTops: number[];
}

const PAD = 12;
const GAP_X = 12;
const GAP_Y = 14;
const MIN_COL_W = 150;
const CENTRO_MAX_W = 360;
const BOX_PAD_X = 6;
const BOX_PAD_Y = 5;
const LINE_H = 11;
const META_H = 12;
// Avg glyph width ~4.7pt at 9pt Helvetica (measured on rendered pt-BR text: lines fill ~85% of the box).
const CHARS_PER_PT = 1 / 4.7;

/** Greedy word wrap; words longer than a line are hard-split. */
function wrap(text: string, maxChars: number): string[] {
  const lines: string[] = [];
  let cur = "";
  for (let word of text.split(/\s+/).filter(Boolean)) {
    while (word.length > maxChars) {
      if (cur) {
        lines.push(cur);
        cur = "";
      }
      lines.push(word.slice(0, maxChars));
      word = word.slice(maxChars);
    }
    if (!cur) cur = word;
    else if (cur.length + 1 + word.length <= maxChars) cur += ` ${word}`;
    else {
      lines.push(cur);
      cur = word;
    }
  }
  if (cur) lines.push(cur);
  return lines.length ? lines : [""];
}

function boxFor(text: string, w: number, meta: boolean) {
  const maxChars = Math.max(4, Math.floor((w - 2 * BOX_PAD_X) * CHARS_PER_PT));
  const lines = wrap(text, maxChars);
  const h = lines.length * LINE_H + 2 * BOX_PAD_Y + (meta ? META_H : 0);
  return { lines, h };
}

/** Pure layout: centro on top, ramos in columns (evitar last), nós stacked per column. */
export function layoutMapaMental(mapa: MapaMental, opts: { width: number }): MapaLayout {
  const width = opts.width;
  const inner = width - 2 * PAD;
  const ramos = [
    ...mapa.ramos.filter((r) => r.tipo !== "evitar"),
    ...mapa.ramos.filter((r) => r.tipo === "evitar"),
  ];
  const cols = Math.max(1, Math.min(ramos.length, Math.floor((inner + GAP_X) / (MIN_COL_W + GAP_X))));
  const colW = (inner - (cols - 1) * GAP_X) / cols;

  const nodes: MapaNode[] = [];
  const edges: MapaEdge[] = [];
  const link = (a: MapaNode, b: MapaNode) =>
    edges.push({ from: a.id, to: b.id, x1: a.x + a.w / 2, y1: a.y + a.h, x2: b.x + b.w / 2, y2: b.y });

  const centroW = Math.min(inner, CENTRO_MAX_W);
  const cb = boxFor(mapa.centro, centroW, false);
  const centro: MapaNode = {
    id: "centro",
    kind: "centro",
    x: (width - centroW) / 2,
    y: PAD,
    w: centroW,
    h: cb.h,
    lines: cb.lines,
  };
  nodes.push(centro);

  let rowY = centro.y + centro.h + GAP_Y * 2;
  const lastInCol: (MapaNode | undefined)[] = Array(cols).fill(undefined);
  const bandTops = [0];
  for (let start = 0; start < ramos.length; start += cols) {
    if (start > 0) bandTops.push(rowY - GAP_Y * 2);
    let rowBottom = rowY;
    ramos.slice(start, start + cols).forEach((ramo, c) => {
      const i = start + c;
      const x = PAD + c * (colW + GAP_X);
      const evitar = ramo.tipo === "evitar";
      const hb = boxFor(ramo.titulo, colW, false);
      const head: MapaNode = {
        id: `ramo-${i}`,
        kind: evitar ? "evitar" : "ramo",
        x,
        y: rowY,
        w: colW,
        h: hb.h,
        lines: hb.lines,
      };
      nodes.push(head);
      link(lastInCol[c] ?? centro, head);
      let prev = head;
      let y = head.y + head.h + GAP_Y;
      ramo.nos.forEach((no, j) => {
        const nb = boxFor(no.texto, colW, true);
        const node: MapaNode = {
          id: `no-${i}-${j}`,
          kind: evitar ? "evitar" : "no",
          x,
          y,
          w: colW,
          h: nb.h,
          lines: nb.lines,
          prazo: no.prazo,
          dono: no.dono,
        };
        nodes.push(node);
        link(prev, node);
        prev = node;
        y += nb.h + GAP_Y;
      });
      lastInCol[c] = prev;
      rowBottom = Math.max(rowBottom, prev.y + prev.h);
    });
    rowY = rowBottom + GAP_Y * 2;
  }

  return { width, height: rowY - GAP_Y * 2 + PAD, nodes, edges, bandTops };
}
