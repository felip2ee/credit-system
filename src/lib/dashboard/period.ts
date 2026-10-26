// Períodos do filtro de faturamento do Dashboard, no fuso de Brasília (UTC-3, sem horário de verão).
const BR_OFFSET_MS = 3 * 60 * 60 * 1000;
const DAY_MS = 86_400_000;

export const REVENUE_PERIODS = [
  { key: "hoje", label: "Hoje" },
  { key: "ontem", label: "Ontem" },
  { key: "7d", label: "7 dias" },
  { key: "mes", label: "Este mês" },
  { key: "3m", label: "3 meses" },
  { key: "9m", label: "9 meses" },
] as const;

export type RevenuePeriodKey = (typeof REVENUE_PERIODS)[number]["key"];

export const DEFAULT_REVENUE_PERIOD: RevenuePeriodKey = "mes";

export function parseRevenuePeriod(value: string | string[] | undefined): RevenuePeriodKey {
  const found = REVENUE_PERIODS.find((p) => p.key === value);
  return found ? found.key : DEFAULT_REVENUE_PERIOD;
}

// Intervalo [start, end) em ISO. "3m" e "9m" contam o mês atual mais os anteriores.
export function revenueRange(key: RevenuePeriodKey, now: number = Date.now()): { start: string; end: string } {
  const br = new Date(now - BR_OFFSET_MS);
  const y = br.getUTCFullYear();
  const m = br.getUTCMonth();
  const startOfDay = Date.UTC(y, m, br.getUTCDate()) + BR_OFFSET_MS;
  const monthsBack = (n: number) => Date.UTC(y, m - n, 1) + BR_OFFSET_MS;
  const tomorrow = startOfDay + DAY_MS;

  const bounds: Record<RevenuePeriodKey, [number, number]> = {
    hoje: [startOfDay, tomorrow],
    ontem: [startOfDay - DAY_MS, startOfDay],
    "7d": [startOfDay - 6 * DAY_MS, tomorrow],
    mes: [monthsBack(0), tomorrow],
    "3m": [monthsBack(2), tomorrow],
    "9m": [monthsBack(8), tomorrow],
  };
  const [start, end] = bounds[key];
  return { start: new Date(start).toISOString(), end: new Date(end).toISOString() };
}
