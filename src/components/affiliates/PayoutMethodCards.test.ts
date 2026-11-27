import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: () => {} }) }));
vi.mock("@/actions/affiliate-payout", () => ({ setPayoutMethodAction: async () => ({ error: null }) }));

import { ASAAS_APP_STORE_LINKS } from "@/lib/affiliates/store-links";

import { PayoutMethodCards } from "./PayoutMethodCards";

const render = (props: Parameters<typeof PayoutMethodCards>[0]) => renderToStaticMarkup(createElement(PayoutMethodCards, props));

describe("PayoutMethodCards", () => {
	it("shows both cards as a labelled radio group with the official store links", () => {
		const html = render({ current: { method: "pix", walletIdMasked: null } });
		expect(html).toContain('role="radiogroup"');
		expect(html).toContain("Conta Asaas");
		expect(html).toContain("Chave Pix");
		expect(html).toContain(ASAAS_APP_STORE_LINKS.android);
		expect(html).toContain(ASAAS_APP_STORE_LINKS.ios);
		expect(html).toContain('rel="noopener noreferrer"');
	});

	it("asks for the walletId only in asaas mode and shows just the masked id", () => {
		const pix = render({ current: { method: "pix", walletIdMasked: null } });
		expect(pix).not.toContain("walletId da conta Asaas");
		const asaas = render({ current: { method: "asaas", walletIdMasked: "a1b2c3d4…ef12" } });
		expect(asaas).toContain("walletId da conta Asaas");
		expect(asaas).toContain("a1b2c3d4…ef12");
	});

	it("names the affiliate when the bureau owner sets it up for them", () => {
		expect(render({ current: { method: "pix", walletIdMasked: null }, profileId: "x", subject: "Maria" })).toContain("em nome de Maria");
	});
});
