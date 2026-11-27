import type { Browser } from "@playwright/test";

import { ensureOrder, type Ids, type Screen } from "./critical-screens";
import { dbQuery, E2E } from "./fixtures";

// Páginas verificadas no reflow (WCAG 1.4.10): uma por área e papel.
export type RouteIds = Ids & { holderId: string; bureauId: string };
export type Route = { name: string; auth: Screen["auth"]; path: (ids: RouteIds) => string };

export const ROUTES: Route[] = [
  { name: "privacidade", auth: "none", path: () => "/privacidade" },
  { name: "termos", auth: "none", path: () => "/termos" },
  { name: "vitrine do Bureau", auth: "none", path: () => `/b/${E2E.bureauSlug}` },
  { name: "cadastro do cliente", auth: "none", path: () => `/b/${E2E.bureauSlug}/cadastro` },
  { name: "entrar", auth: "none", path: () => `/b/${E2E.bureauSlug}/entrar` },
  { name: "login", auth: "none", path: () => "/login" },
  { name: "portal: início", auth: "client", path: () => "/portal" },
  { name: "portal: perfil", auth: "client", path: () => "/portal/perfil" },
  { name: "portal: pesquisas", auth: "client", path: () => "/portal/pesquisas" },
  { name: "portal: nova pesquisa", auth: "client", path: () => "/portal/pesquisas/nova" },
  { name: "portal: pedido", auth: "client", path: (ids) => `/portal/pesquisas/${ids.dossierId}` },
  { name: "portal: créditos", auth: "client", path: () => "/portal/credits" },
  { name: "portal: notificações", auth: "client", path: () => "/portal/notificacoes" },
  { name: "portal: afiliação", auth: "client", path: () => "/portal/afiliacao" },
  { name: "portal: saque", auth: "client", path: () => "/portal/afiliacao/saque" },
  { name: "bureau: início", auth: "staff", path: () => "/" },
  { name: "bureau: titulares", auth: "staff", path: () => "/holders" },
  { name: "bureau: novo titular", auth: "staff", path: () => "/holders/new" },
  { name: "bureau: titular", auth: "staff", path: (ids) => `/holders/${ids.holderId}` },
  { name: "bureau: editar titular", auth: "staff", path: (ids) => `/holders/${ids.holderId}/edit` },
  { name: "bureau: dossiês", auth: "staff", path: () => "/dossiers" },
  { name: "bureau: dossiê", auth: "staff", path: (ids) => `/dossiers/${ids.dossierId}` },
  { name: "bureau: carteira", auth: "admin", path: () => "/settings/wallet" },
  { name: "bureau: repasses", auth: "admin", path: () => "/settings/payouts" },
  { name: "bureau: usuários", auth: "admin", path: () => "/settings/users" },
  { name: "bureau: afiliados", auth: "admin", path: () => "/afiliados" },
  { name: "app: balcão", auth: "staff", path: () => "/admin" },
  { name: "app: links", auth: "staff", path: () => "/admin/links" },
  { name: "app: cobranças", auth: "staff", path: () => "/admin/cobrancas" },
  { name: "app: consulta", auth: "staff", path: () => "/admin/consulta" },
  { name: "superadmin: início", auth: "superadmin", path: () => "/superadmin" },
  { name: "superadmin: Bureau", auth: "superadmin", path: (ids) => `/superadmin/bureaus/${ids.bureauId}` },
  { name: "superadmin: repasses", auth: "superadmin", path: () => "/superadmin/payouts" },
  { name: "superadmin: saques", auth: "superadmin", path: () => "/superadmin/saques" },
  { name: "superadmin: prompts", auth: "superadmin", path: () => "/superadmin/settings/prompts" },
  { name: "superadmin: produtos", auth: "superadmin", path: () => "/superadmin/products" },
  { name: "superadmin: NFS-e", auth: "superadmin", path: () => "/superadmin/nfse" },
];


export async function loadRouteIds(browser: Browser): Promise<RouteIds> {
  const base = await ensureOrder(browser);
  const [holder] = await dbQuery<{ id: string }>(
    "select h.id from holders h join bureaus b on b.id = h.bureau_id where b.slug = $1 order by h.created_at limit 1",
    [E2E.bureauSlug],
  );
  const [bureau] = await dbQuery<{ id: string }>("select id from bureaus where slug = $1", [E2E.bureauSlug]);
  return { ...base, holderId: holder.id, bureauId: bureau.id };
}
