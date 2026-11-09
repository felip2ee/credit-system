import { describe, expect, it } from "vitest";

import { parseWalletTab, visibleWalletTabs } from "./tabs";

describe("visibleWalletTabs", () => {
  it("só online e extrato sem permissões", () => {
    expect(visibleWalletTabs({ payout: false, counter: false })).toEqual(["online", "extrato"]);
  });
  it("mostra as abas permitidas, em ordem", () => {
    expect(visibleWalletTabs({ payout: true, counter: true })).toEqual(["online", "balcao", "extrato", "receber"]);
    expect(visibleWalletTabs({ payout: false, counter: true })).toEqual(["online", "balcao", "extrato"]);
    expect(visibleWalletTabs({ payout: true, counter: false })).toEqual(["online", "extrato", "receber"]);
  });
});

describe("parseWalletTab", () => {
  const all = visibleWalletTabs({ payout: true, counter: true });
  it("aceita aba da lista", () => {
    expect(parseWalletTab("balcao", all)).toBe("balcao");
    expect(parseWalletTab("extrato", all)).toBe("extrato");
  });
  it("cai em online se inválida, ausente ou lista", () => {
    expect(parseWalletTab("x", all)).toBe("online");
    expect(parseWalletTab(undefined, all)).toBe("online");
    expect(parseWalletTab(["balcao"], all)).toBe("online");
  });
  it("a-receber antigo vira receber", () => {
    expect(parseWalletTab("a-receber", all)).toBe("receber");
  });
  it("aba sem permissão cai em online", () => {
    expect(parseWalletTab("receber", ["online", "extrato"])).toBe("online");
    expect(parseWalletTab("a-receber", ["online", "extrato"])).toBe("online");
    expect(parseWalletTab("balcao", ["online", "extrato"])).toBe("online");
  });
});
