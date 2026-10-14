import { Badge, type BadgeProps } from "@/components/ui/badge";
import type { AptitudeStatus, DossierKind, DossierStatus } from "@/types/app";

export const DOSSIER_KIND_LABEL: Record<DossierKind, string> = {
  PF: "Consulta PF",
  PJ: "Consulta PJ",
  PJ_FULL: "PJ completo",
};

const STATUS: Record<DossierStatus, { label: string; variant: BadgeProps["variant"] }> = {
  pending: { label: "Pendente", variant: "secondary" },
  processing: { label: "Em andamento", variant: "secondary" },
  completed: { label: "Concluído", variant: "success" },
  completed_with_errors: { label: "Concluído com erros", variant: "destructive" },
  cancelled: { label: "Cancelado", variant: "muted" },
};

const APTITUDE: Record<AptitudeStatus, { label: string; variant: BadgeProps["variant"] }> = {
  apt: { label: "Apto", variant: "success" },
  apt_with_caveats: { label: "Apto com ressalvas", variant: "secondary" },
  inapt: { label: "Inapto", variant: "destructive" },
  pending: { label: "Pendente", variant: "muted" },
};

export const isDossierKind = (value: string): value is DossierKind => Object.hasOwn(DOSSIER_KIND_LABEL, value);
const isDossierStatus = (value: string): value is DossierStatus => Object.hasOwn(STATUS, value);
const isAptitudeStatus = (value: string): value is AptitudeStatus => Object.hasOwn(APTITUDE, value);

export function DossierStatusBadge({ status }: { status: string }) {
  const item = isDossierStatus(status) ? STATUS[status] : STATUS.pending;
  return <Badge variant={item.variant}>{item.label}</Badge>;
}

export function AptitudeBadge({ status }: { status: string }) {
  const item = isAptitudeStatus(status) ? APTITUDE[status] : APTITUDE.pending;
  return <Badge variant={item.variant}>{item.label}</Badge>;
}
