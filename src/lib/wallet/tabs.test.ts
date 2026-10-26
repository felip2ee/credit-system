import { describe, expect, it } from "vitest";

import { parseWalletTab, visibleWalletTabs } from "./tabs";

describe("visibleWalletTabs", () => {
  it("só extrato sem permissões", () => {
    expect(visibleWalletTabs({ payout: false, counter: false })).toEqual(["extrato"]);
  });
  it("mostra as abas permitidas, em ordem", () => {
    expect(visibleWalletTabs({ payout: true, counter: true })).toEqual(["extrato", "a-receber", "balcao"]);
    expect(visibleWalletTabs({ payout: false, counter: true })).toEqual(["extrato", "balcao"]);
  });
});

describe("parseWalletTab", () => {
  const all = visibleWalletTabs({ payout: true, counter: true });
  it("aceita aba da lista", () => {
    expect(parseWalletTab("balcao", all)).toBe("balcao");
  });
  it("cai em extrato se inválida, ausente, lista ou sem permissão", () => {
    expect(parseWalletTab("x", all)).toBe("extrato");
    expect(parseWalletTab(undefined, all)).toBe("extrato");
    expect(parseWalletTab(["balcao"], all)).toBe("extrato");
    expect(parseWalletTab("a-receber", ["extrato"])).toBe("extrato");
  });
});
