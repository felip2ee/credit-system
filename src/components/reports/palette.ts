// Paleta dos gráficos do Dashboard. Classes Tailwind LITERAIS (bar/fill/stroke)
// para sobreviver ao purge e manter os tokens do tema. Cada categoria mapeia
// seus itens para uma "hue" daqui.

export type Hue =
  | "emerald"
  | "emeraldDark"
  | "amber"
  | "sky"
  | "indigo"
  | "red"
  | "slate"
  | "slateLight"
  | "violet";

export interface HueClasses {
  bar: string;
  fill: string;
  stroke: string;
}

export const HUE: Record<Hue, HueClasses> = {
  emerald: { bar: "bg-emerald-500", fill: "fill-emerald-500", stroke: "stroke-emerald-500" },
  emeraldDark: { bar: "bg-emerald-600", fill: "fill-emerald-600", stroke: "stroke-emerald-600" },
  amber: { bar: "bg-amber-500", fill: "fill-amber-500", stroke: "stroke-amber-500" },
  sky: { bar: "bg-sky-500", fill: "fill-sky-500", stroke: "stroke-sky-500" },
  indigo: { bar: "bg-indigo-500", fill: "fill-indigo-500", stroke: "stroke-indigo-500" },
  red: { bar: "bg-red-500", fill: "fill-red-500", stroke: "stroke-red-500" },
  slate: { bar: "bg-slate-400", fill: "fill-slate-400", stroke: "stroke-slate-400" },
  slateLight: { bar: "bg-slate-300", fill: "fill-slate-300", stroke: "stroke-slate-300" },
  violet: { bar: "bg-violet-500", fill: "fill-violet-500", stroke: "stroke-violet-500" },
};
