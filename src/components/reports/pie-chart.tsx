import { cn } from "@/lib/utils";

export interface PieSegment {
  label: string;
  value: number;
  fillClass: string; // ex.: "fill-emerald-500"
  barClass: string; // ex.: "bg-emerald-500" (legenda)
}

interface PieChartProps {
  segments: PieSegment[];
  size?: number;
}

function polar(cx: number, cy: number, r: number, angleDeg: number) {
  const a = ((angleDeg - 90) * Math.PI) / 180;
  return [cx + r * Math.cos(a), cy + r * Math.sin(a)] as const;
}

// Gráfico de pizza em SVG puro + legenda. Sem interatividade → Server Component.
export function PieChart({ segments, size = 168 }: PieChartProps) {
  const total = segments.reduce((acc, s) => acc + s.value, 0);
  const r = size / 2;
  const cx = r;
  const cy = r;
  const nonZero = segments.filter((s) => s.value > 0);

  return (
    <div className="flex flex-col items-center gap-4 sm:flex-row sm:gap-6">
      <svg
        width={size}
        height={size}
        viewBox={`0 0 ${size} ${size}`}
        role="img"
        aria-label="Gráfico de pizza"
        className="shrink-0"
      >
        {total === 0 ? (
          <circle cx={cx} cy={cy} r={r} className="fill-muted" />
        ) : nonZero.length === 1 ? (
          <circle cx={cx} cy={cy} r={r} className={cn(nonZero[0].fillClass)} />
        ) : (
          (() => {
            let angle = 0;
            return nonZero.map((s) => {
              const slice = (s.value / total) * 360;
              const [x1, y1] = polar(cx, cy, r, angle);
              const [x2, y2] = polar(cx, cy, r, angle + slice);
              const largeArc = slice > 180 ? 1 : 0;
              const d = `M ${cx} ${cy} L ${x1} ${y1} A ${r} ${r} 0 ${largeArc} 1 ${x2} ${y2} Z`;
              angle += slice;
              return <path key={s.label} d={d} className={cn(s.fillClass)} />;
            });
          })()
        )}
      </svg>

      <ul className="w-full flex-1 space-y-2">
        {segments.map((s) => (
          <li key={s.label} className="flex items-center justify-between text-sm">
            <span className="flex items-center gap-2">
              <span className={cn("h-2.5 w-2.5 rounded-sm", s.barClass)} />
              {s.label}
            </span>
            <span className="text-muted-foreground">
              {s.value} · {total > 0 ? Math.round((s.value / total) * 100) : 0}%
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
