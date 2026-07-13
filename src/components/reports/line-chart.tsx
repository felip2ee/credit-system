import { cn } from "@/lib/utils";

export interface LineSeries {
  label: string;
  points: number[]; // mesmo comprimento de xLabels
  strokeClass: string; // ex.: "stroke-emerald-500"
  dotClass: string; // ex.: "fill-emerald-500"
  chipClass: string; // ex.: "bg-emerald-500" (legenda)
}

interface LineChartProps {
  xLabels: string[];
  series: LineSeries[];
  showLegend?: boolean;
}

const W = 520;
const H = 200;
const PAD_L = 10;
const PAD_R = 10;
const PAD_T = 14;
const PAD_B = 30;

export function LineChart({ xLabels, series, showLegend = true }: LineChartProps) {
  const n = xLabels.length;
  const plotW = W - PAD_L - PAD_R;
  const plotH = H - PAD_T - PAD_B;
  const baseY = PAD_T + plotH;

  const max = Math.max(
    1,
    ...series.flatMap((s) => s.points.map((p) => (Number.isFinite(p) ? p : 0)))
  );

  const xAt = (i: number) =>
    n <= 1 ? PAD_L + plotW / 2 : PAD_L + (plotW * i) / (n - 1);
  const yAt = (v: number) => PAD_T + plotH * (1 - v / max);

  const hasData = series.some((s) => s.points.some((p) => p > 0));

  return (
    <div className="w-full">
      <svg
        viewBox={`0 0 ${W} ${H}`}
        preserveAspectRatio="xMidYMid meet"
        role="img"
        aria-label="Gráfico de linha"
        className="h-auto w-full"
      >
        {/* eixo base */}
        <line x1={PAD_L} y1={baseY} x2={W - PAD_R} y2={baseY} className="stroke-border" strokeWidth={1} />

        {hasData &&
          series.map((s) => {
            const pts = s.points.map((v, i) => `${xAt(i)},${yAt(v)}`).join(" ");
            return (
              <g key={s.label}>
                <polyline
                  points={pts}
                  fill="none"
                  strokeWidth={2}
                  strokeLinejoin="round"
                  strokeLinecap="round"
                  className={cn(s.strokeClass)}
                />
                {s.points.map((v, i) => (
                  <circle
                    key={i}
                    cx={xAt(i)}
                    cy={yAt(v)}
                    r={3}
                    className={cn(s.dotClass)}
                  />
                ))}
              </g>
            );
          })}

        {/* rótulos do eixo X */}
        {xLabels.map((label, i) => (
          <text
            key={i}
            x={xAt(i)}
            y={H - 10}
            textAnchor="middle"
            className="fill-muted-foreground text-[9px] capitalize"
          >
            {label.length > 12 ? `${label.slice(0, 11)}…` : label}
          </text>
        ))}
      </svg>

      {showLegend && series.length > 1 && (
        <div className="mt-2 flex flex-wrap items-center justify-center gap-4 text-xs text-muted-foreground">
          {series.map((s) => (
            <span key={s.label} className="flex items-center gap-1.5">
              <span className={cn("h-2.5 w-2.5 rounded-sm", s.chipClass)} />
              {s.label}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
