import { HUE, type Hue } from "@/components/reports/palette";
import { LineChart } from "@/components/reports/line-chart";
import { PieChart } from "@/components/reports/pie-chart";

export interface CategoryItem {
  label: string;
  value: number;
  hue: Hue;
}

// Pizza (distribuição) + linha (curva pelas categorias) lado a lado, para uma
// mesma categoria do Dashboard. Server Component.
export function CategoryCharts({
  items,
  emptyLabel = "Sem dados.",
}: {
  items: CategoryItem[];
  emptyLabel?: string;
}) {
  const total = items.reduce((acc, i) => acc + i.value, 0);
  if (total === 0) {
    return <p className="text-sm text-muted-foreground">{emptyLabel}</p>;
  }

  const pieSegments = items.map((i) => ({
    label: i.label,
    value: i.value,
    fillClass: HUE[i.hue].fill,
    barClass: HUE[i.hue].bar,
  }));

  const lineSeries = [
    {
      label: "Quantidade",
      points: items.map((i) => i.value),
      strokeClass: "stroke-primary",
      dotClass: "fill-primary",
      chipClass: "bg-primary",
    },
  ];

  return (
    <div className="grid grid-cols-1 items-center gap-6 lg:grid-cols-2">
      <PieChart segments={pieSegments} />
      <LineChart
        xLabels={items.map((i) => i.label)}
        series={lineSeries}
        showLegend={false}
      />
    </div>
  );
}
