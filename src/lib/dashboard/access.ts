import { hasPermission, type PermissionSubject } from "@/lib/db/permissions";

// Faturamento só para quem vê repasses. Superadmin em suporte também tem payout:read (união
// com as permissões do operador), então a sessão de suporte é excluída de forma explícita.
export function canViewRevenue(subject: PermissionSubject): boolean {
  return !subject.supportSessionId && hasPermission(subject, "payout:read");
}
