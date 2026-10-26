import { StatusBadge } from "@/components/ui/status-badge";
import type { StateTone } from "@/components/ui/state-tone";
import type { AptitudeStatus, DossierKind, DossierStatus } from "@/types/app";

export const DOSSIER_KIND_LABEL: Record<DossierKind, string> = {
  PF: "Consulta PF",
  PJ: "Consulta PJ",
  PJ_FULL: "PJ completo",
};

const STATUS: Record<DossierStatus, { label: string; tone: StateTone }> = {
  pending: { label: "Pendente", tone: "waiting" },
  processing: { label: "Em andamento", tone: "progress" },
  completed: { label: "Concluído", tone: "success" },
  completed_with_errors: { label: "Concluído com erros", tone: "attention" },
  cancelled: { label: "Cancelado", tone: "neutral" },
};

const APTITUDE: Record<AptitudeStatus, { label: string; tone: StateTone }> = {
  apt: { label: "Apto", tone: "success" },
  apt_with_caveats: { label: "Apto com ressalvas", tone: "attention" },
  inapt: { label: "Inapto", tone: "danger" },
  pending: { label: "Pendente", tone: "neutral" },
};

export const isDossierKind = (value: string): value is DossierKind => Object.hasOwn(DOSSIER_KIND_LABEL, value);
const isDossierStatus = (value: string): value is DossierStatus => Object.hasOwn(STATUS, value);
const isAptitudeStatus = (value: string): value is AptitudeStatus => Object.hasOwn(APTITUDE, value);

export function DossierStatusBadge({ status }: { status: string }) {
  const item = isDossierStatus(status) ? STATUS[status] : STATUS.pending;
  return <StatusBadge tone={item.tone} label={item.label} />;
}

export function AptitudeBadge({ status }: { status: string }) {
  const item = isAptitudeStatus(status) ? APTITUDE[status] : APTITUDE.pending;
  return <StatusBadge tone={item.tone} label={item.label} />;
}
