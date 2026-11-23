import { layoutMapaMental, type MapaNode } from "@/lib/ai/mapa-mental-layout";
import { MapaMentalSchema, type MapaMental } from "@/types/ai";

const LAYOUT_WIDTH = 780;
const LINE_H = 11;
const PAD_X = 6;
const PAD_Y = 5;

type Prazo = MapaMental["ramos"][number]["nos"][number]["prazo"];

export const PRAZO_LABEL: Record<Prazo, string> = {
  "30_dias": "30 dias",
  "60_dias": "60 dias",
  "90_dias": "90 dias",
  "180_dias": "180 dias",
  continuo: "Contínuo",
};

const prazoLabel = (p: string) => PRAZO_LABEL[p as Prazo] ?? p;

// Cores por tipo de nó, só com tokens do tema (claro e escuro).
const TONE: Record<MapaNode["kind"], { fill: string; stroke: string; text: string }> = {
  centro: { fill: "hsl(var(--primary))", stroke: "hsl(var(--primary))", text: "hsl(var(--primary-foreground))" },
  ramo: { fill: "hsl(var(--accent))", stroke: "hsl(var(--border))", text: "hsl(var(--accent-foreground))" },
  no: { fill: "hsl(var(--card))", stroke: "hsl(var(--border))", text: "hsl(var(--card-foreground))" },
  evitar: { fill: "hsl(var(--card))", stroke: "hsl(var(--destructive))", text: "hsl(var(--card-foreground))" },
};

function Node({ node }: { node: MapaNode }) {
  const tone = TONE[node.kind];
  const bold = node.kind === "centro" || node.kind === "ramo";
  return (
    <g>
      <rect
        x={node.x}
        y={node.y}
        width={node.w}
        height={node.h}
        rx={3}
        fill={tone.fill}
        stroke={tone.stroke}
        strokeWidth={node.kind === "evitar" ? 1.5 : 1}
        strokeDasharray={node.kind === "evitar" ? "4 2" : undefined}
      />
      <text fontSize={9} fontWeight={bold ? 700 : 400} fill={tone.text}>
        {node.lines.map((line, i) => (
          <tspan key={i} x={node.x + PAD_X} y={node.y + PAD_Y + LINE_H * (i + 1) - 2}>
            {line}
          </tspan>
        ))}
      </text>
      {node.prazo && (
        <text
          x={node.x + PAD_X}
          y={node.y + node.h - 4}
          fontSize={8}
          fill={node.kind === "evitar" ? "hsl(var(--destructive))" : "hsl(var(--muted-foreground))"}
        >
          {[prazoLabel(node.prazo), node.dono].filter(Boolean).join(" · ")}
        </text>
      )}
    </g>
  );
}

/** Mapa mental do plano de ação: SVG visual + lista aninhada equivalente para leitor de tela. */
export function MapaMentalView({ mapa }: { mapa?: unknown }) {
  const parsed = MapaMentalSchema.safeParse(mapa);
  if (!parsed.success) return null;
  const data = parsed.data;
  const layout = layoutMapaMental(data, { width: LAYOUT_WIDTH });
  const byId = new Map(layout.nodes.map((n) => [n.id, n]));

  return (
    <section aria-label="Mapa mental do plano de ação" className="space-y-2">
      <h3 className="text-sm font-semibold">Mapa mental do plano de ação</h3>
      <div className="overflow-x-auto rounded-md border bg-card">
        <svg
          role="img"
          aria-label={`Mapa mental do plano de ação: ${data.centro}. ${data.ramos.length} ramos. A lista abaixo traz o mesmo conteúdo em texto.`}
          viewBox={`0 0 ${layout.width} ${layout.height}`}
          className="block h-auto w-full min-w-[720px]"
        >
          {layout.edges.map((e, i) => (
            <line
              key={i}
              x1={e.x1}
              y1={e.y1}
              x2={e.x2}
              y2={e.y2}
              stroke={byId.get(e.to)?.kind === "evitar" ? "hsl(var(--destructive))" : "hsl(var(--border))"}
              strokeWidth={1}
            />
          ))}
          {layout.nodes.map((n) => (
            <Node key={n.id} node={n} />
          ))}
        </svg>
      </div>
      <div className="sr-only">
        <p>{data.centro}</p>
        <ul>
          {data.ramos.map((ramo, i) => (
            <li key={i}>
              {ramo.tipo === "evitar" ? `Evitar: ${ramo.titulo}` : ramo.titulo}
              <ul>
                {ramo.nos.map((no, j) => (
                  <li key={j}>
                    {no.texto}. Prazo: {PRAZO_LABEL[no.prazo]}. Responsável: {no.dono}.
                  </li>
                ))}
              </ul>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}
