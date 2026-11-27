import { describe, expect, it } from "vitest";

import { DASHBOARD_NAV_ITEMS, SETTINGS_PAGES, SUPERADMIN_NAV_ITEMS, groupNavItems, isNavActive, visibleNavItems } from "./nav-items";

const items = [
  { href: "/", label: "Dashboard" },
  { href: "/settings/counter-payments", label: "Balcão", permission: "counter:read" as const },
  { href: "/settings/payouts", label: "Repasses", permission: "payout:read" as const },
];

describe("visibleNavItems", () => {
  it("mostra item sem permissão para todos", () => {
    expect(visibleNavItems(items, []).map((i) => i.href)).toEqual(["/"]);
  });

  it("esconde o item cuja permissão falta", () => {
    expect(visibleNavItems(items, ["counter:read"]).map((i) => i.href)).toEqual(["/", "/settings/counter-payments"]);
  });

  it("mostra todos com as duas permissões", () => {
    expect(visibleNavItems(items, ["counter:read", "payout:read"])).toHaveLength(3);
  });
});

describe("DASHBOARD_NAV_ITEMS", () => {
  it("Repasses e Pagamentos de balcão vivem dentro da Carteira", () => {
    const hrefs = DASHBOARD_NAV_ITEMS.map((i) => i.href);
    expect(hrefs).not.toContain("/settings/payouts");
    expect(hrefs).not.toContain("/settings/counter-payments");
  });
});

describe("SUPERADMIN_NAV_ITEMS", () => {
  it("tem o ajuste do prazo de retenção dos repasses", () => {
    expect(SUPERADMIN_NAV_ITEMS).toContainEqual({ href: "/superadmin/settings/repasses", label: "Prazo dos repasses", group: "Configurações" });
  });

  it("agrupa em Operação, Catálogo e Configurações, com a comissão dos bureaus", () => {
    expect(groupNavItems(SUPERADMIN_NAV_ITEMS).map((g) => [g.title, g.items.map((i) => i.label)])).toEqual([
      ["Operação", ["Bureaus", "Saques", "Repasses", "Split da entrada", "NFS-e", "Notificações"]],
      ["Catálogo", ["Produtos"]],
      ["Configurações", ["Todas as configurações", "Comissão dos Bureaus", "Prazo dos repasses", "Afiliados", "Termo SCR", "Prompts da IA"]],
    ]);
  });
});

describe("isNavActive", () => {
  it("Carteira ativa nas sub-rotas, Configurações não", () => {
    expect(isNavActive("/settings/wallet", "/settings/wallet")).toBe(true);
    expect(isNavActive("/settings/counter-payments", "/settings/wallet")).toBe(true);
    expect(isNavActive("/settings/payouts", "/settings/wallet")).toBe(true);
    expect(isNavActive("/settings/counter-payments", "/settings")).toBe(false);
    expect(isNavActive("/settings/team", "/settings")).toBe(true);
  });
});

const groupsOf = (permissions: Parameters<typeof visibleNavItems>[1]) =>
  groupNavItems(visibleNavItems(DASHBOARD_NAV_ITEMS, permissions)).map((g) => [g.title, g.items.map((i) => i.label)]);

describe("groupNavItems", () => {
  it("agrupa o painel em Operação, Financeiro e Conta", () => {
    expect(groupsOf(["coupons:read", "affiliates:read"])).toEqual([
      ["Operação", ["Dashboard", "Pesquisas", "Titulares", "Autorizações SCR"]],
      ["Financeiro", ["Carteira", "Cupons", "Catálogo", "Afiliados"]],
      ["Conta", ["Configurações"]],
    ]);
  });

  it("esconde só os itens sem permissão e mantém o grupo com itens visíveis", () => {
    expect(groupsOf([])[1]).toEqual(["Financeiro", ["Carteira", "Catálogo"]]);
  });

  it("não devolve grupo sem item visível", () => {
    const only = groupNavItems(visibleNavItems([{ href: "/a", label: "A", group: "X", permission: "coupons:read" }, { href: "/b", label: "B", group: "Y" }], []));
    expect(only.map((g) => g.title)).toEqual(["Y"]);
  });

  it("itens sem grupo ficam numa lista só, sem título", () => {
    const loose = [{ href: "/a", label: "A" }, { href: "/b", label: "B" }];
    const groups = groupNavItems(loose);
    expect(groups).toHaveLength(1);
    expect(groups[0]).toEqual({ title: null, items: loose });
  });

  it("mantém rota e permissão de cada item", () => {
    expect(DASHBOARD_NAV_ITEMS.map((i) => [i.href, i.permission ?? null])).toEqual([
      ["/", null], ["/dossiers", null], ["/holders", null], ["/scr", null],
      ["/settings/wallet", null], ["/settings/cupons", "coupons:read"], ["/settings/catalog", null], ["/afiliados", "affiliates:read"],
      ["/settings", null],
    ]);
  });
});

describe("isNavActive em todas as rotas do painel", () => {
  const route = (p: string) => DASHBOARD_NAV_ITEMS.filter((i) => isNavActive(p, i.href)).map((i) => i.label);
  it.each([
    ["/", "Dashboard"],
    ["/dossiers/new", "Pesquisas"],
    ["/holders/abc", "Titulares"],
    ["/scr", "Autorizações SCR"],
    ["/afiliados", "Afiliados"],
    ["/settings", "Configurações"],
    ["/settings/security", "Configurações"],
    ["/settings/users", "Configurações"],
    ["/settings/audit", "Configurações"],
    ["/settings/catalog", "Catálogo"],
    ["/settings/cupons", "Cupons"],
    ["/settings/wallet", "Carteira"],
    ["/settings/counter-payments", "Carteira"],
    ["/settings/payouts", "Carteira"],
  ])("%s ativa só %s", (path, label) => {
    expect(route(path)).toEqual([label]);
  });
});

describe("isNavActive em todas as rotas do superadmin", () => {
  const route = (p: string) => SUPERADMIN_NAV_ITEMS.filter((i) => isNavActive(p, i.href)).map((i) => i.label);
  it.each([
    ["/superadmin", "Bureaus"],
    ["/superadmin/bureaus/new", "Bureaus"],
    ["/superadmin/bureaus/abc", "Bureaus"],
    ["/superadmin/saques", "Saques"],
    ["/superadmin/saques/abc", "Saques"],
    ["/superadmin/payouts", "Repasses"],
    ["/superadmin/nfse", "NFS-e"],
    ["/superadmin/notifications", "Notificações"],
    ["/superadmin/products", "Produtos"],
    ["/superadmin/products/new", "Produtos"],
    ["/superadmin/products/abc", "Produtos"],
    ["/superadmin/settings", "Todas as configurações"],
    ["/superadmin/settings/comissao", "Comissão dos Bureaus"],
    ["/superadmin/settings/repasses", "Prazo dos repasses"],
    ["/superadmin/settings/afiliados", "Afiliados"],
    ["/superadmin/settings/scr", "Termo SCR"],
    ["/superadmin/settings/prompts", "Prompts da IA"],
  ])("%s ativa só %s", (path, label) => {
    expect(route(path)).toEqual([label]);
  });
});

describe("SETTINGS_PAGES", () => {
  const labels = (permissions: Parameters<typeof visibleNavItems>[1]) => visibleNavItems(SETTINGS_PAGES, permissions).map((p) => p.label);
  it("operador sem permissões extras vê só o que a página aceita", () => {
    expect(labels(["catalog:read", "wallet:read", "counter:read"])).toEqual(["Segurança (MFA)", "Catálogo", "Carteira", "Pagamentos de balcão"]);
  });
  it("admin vê Equipe, Auditoria e Cupons também", () => {
    expect(labels(["users:manage", "audit:read", "coupons:read", "catalog:read", "wallet:read", "counter:read"])).toHaveLength(7);
  });
  it("toda página tem uma descrição", () => {
    expect(SETTINGS_PAGES.every((p) => p.description.length > 10)).toBe(true);
  });
});
