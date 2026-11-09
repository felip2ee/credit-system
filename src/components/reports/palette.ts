// Paleta dos gráficos do Dashboard. Classes Tailwind LITERAIS (bar/fill/stroke)
// para sobreviver ao purge e manter os tokens do tema. Cada categoria mapeia
// seus itens para uma "hue" daqui. Nomes antigos mantidos (outros arquivos os
// usam); os valores agora são verde/amarelo/branco do tema escuro (--chart-1..5).
// Séries vizinhas variam em luminosidade: amarelo, verde claro, verde médio, branco.

export type Hue =
  | "emerald"
  | "emeraldDark"
  | "amber"
  | "sky"
  | "indigo"
  | "red"
  | "slate"
  | "slateLight"
  | "violet"
  | "brand";

export interface HueClasses {
  bar: string;
  fill: string;
  stroke: string;
}

export const HUE: Record<Hue, HueClasses> = {
  emerald: { bar: "bg-chart-1", fill: "fill-chart-1", stroke: "stroke-chart-1" },
  emeraldDark: { bar: "bg-chart-4", fill: "fill-chart-4", stroke: "stroke-chart-4" },
  amber: { bar: "bg-chart-3", fill: "fill-chart-3", stroke: "stroke-chart-3" },
  sky: { bar: "bg-chart-2", fill: "fill-chart-2", stroke: "stroke-chart-2" },
  indigo: { bar: "bg-chart-5", fill: "fill-chart-5", stroke: "stroke-chart-5" },
  red: { bar: "bg-destructive", fill: "fill-destructive", stroke: "stroke-destructive" },
  slate: { bar: "bg-chart-4", fill: "fill-chart-4", stroke: "stroke-chart-4" },
  slateLight: { bar: "bg-chart-2", fill: "fill-chart-2", stroke: "stroke-chart-2" },
  brand: { bar: "bg-chart-1", fill: "fill-chart-1", stroke: "stroke-chart-1" },
  violet: { bar: "bg-chart-5", fill: "fill-chart-5", stroke: "stroke-chart-5" },
};
