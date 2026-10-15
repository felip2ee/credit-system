import type { Permission } from "@/lib/db/permissions";

export interface NavItem {
  href: string;
  label: string;
  // Sem permissão = visível para todos os papéis do painel.
  permission?: Permission;
}

export function visibleNavItems<T extends NavItem>(items: readonly T[], permissions: readonly Permission[]): T[] {
  return items.filter((item) => !item.permission || permissions.includes(item.permission));
}
