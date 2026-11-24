import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	resolve: vi.fn(),
	catalog: vi.fn(),
	buffer: vi.fn(),
	legal: vi.fn(),
}));

vi.mock("next/navigation", () => ({
	redirect: (url: string) => {
		throw new Error(`REDIRECT:${url}`);
	},
	permanentRedirect: () => {
		throw new Error("permanentRedirect must not be used");
	},
	notFound: () => {
		throw new Error("NOT_FOUND");
	},
}));
vi.mock("next/font/google", () => ({ Fraunces: () => ({ variable: "" }), Inter: () => ({ variable: "" }) }));
vi.mock("@/lib/bureaus/public", () => ({ resolveBureauSlug: mocks.resolve, getPublicCatalog: mocks.catalog }));
vi.mock("@/lib/bureau-admin/visit-buffer", () => ({ bufferBureauVisit: mocks.buffer }));
vi.mock("@/lib/account/queries", () => ({ getCurrentLegalDocuments: mocks.legal }));
vi.mock("@/components/portal/landing/landing-closing", () => ({ LandingFinalCta: () => null, LandingFooter: () => null }));
vi.mock("@/components/portal/landing/landing-dossiers", () => ({ LandingDossiers: () => null, LandingWhy: () => null }));
vi.mock("@/components/portal/landing/landing-hero", () => ({ LandingHeader: () => null, LandingHero: () => null }));
vi.mock("@/components/portal/landing/landing-trust", () => ({
	LandingDifferential: () => null,
	LandingFaq: () => null,
	LandingSteps: () => null,
}));
vi.mock("@/components/ui/toaster", () => ({ Toaster: () => null }));
vi.mock("@/components/auth/login-form", () => ({ LoginForm: () => null }));
vi.mock("@/components/portal/public-shell", () => ({ PublicShell: () => null }));
vi.mock("@/components/ui/button", () => ({ Button: () => null }));
vi.mock("@/components/register/register-form", () => ({ RegisterForm: () => null }));

import RegisterPage from "./cadastro/page";
import PublicBureauEntryPage from "./entrar/page";
import PublicBureauPage from "./page";

beforeEach(() => {
	vi.clearAllMocks();
	mocks.catalog.mockResolvedValue([]);
	mocks.legal.mockResolvedValue({ terms: { version: "1" }, privacy: { version: "1" } });
});

describe("/b/<slug> visit counting", () => {
	it("buffers the visit of an active bureau and does not wait for it", async () => {
		mocks.resolve.mockResolvedValue({ kind: "bureau", bureau: { name: "Acme", slug: "acme" } });
		mocks.buffer.mockReturnValue(new Promise(() => {})); // nunca resolve: a página não pode esperar
		await expect(PublicBureauPage({ params: { slug: "acme" } })).resolves.toBeTruthy();
		expect(mocks.buffer).toHaveBeenCalledWith("acme");
	});

	it("does not count redirects or unknown slugs", async () => {
		mocks.resolve.mockResolvedValueOnce({ kind: "redirect", slug: "novo" });
		await expect(PublicBureauPage({ params: { slug: "velho" } })).rejects.toThrow("REDIRECT:/b/novo");
		mocks.resolve.mockResolvedValueOnce({ kind: "missing" });
		await expect(PublicBureauPage({ params: { slug: "x" } })).rejects.toThrow("NOT_FOUND");
		expect(mocks.buffer).not.toHaveBeenCalled();
	});
});

describe("old slug redirects (temporary, 307)", () => {
	beforeEach(() => mocks.resolve.mockResolvedValue({ kind: "redirect", slug: "novo" }));

	it("entrar keeps next", async () => {
		await expect(
			PublicBureauEntryPage({ params: { slug: "velho" }, searchParams: { next: "/pedidos?a=1" } }),
		).rejects.toThrow("REDIRECT:/b/novo/entrar?next=%2Fpedidos%3Fa%3D1");
		await expect(PublicBureauEntryPage({ params: { slug: "velho" }, searchParams: {} })).rejects.toThrow(
			"REDIRECT:/b/novo/entrar",
		);
	});

	it("cadastro keeps ref", async () => {
		await expect(RegisterPage({ params: { slug: "velho" }, searchParams: { ref: "ABC 1" } })).rejects.toThrow(
			"REDIRECT:/b/novo/cadastro?ref=ABC%201",
		);
		await expect(RegisterPage({ params: { slug: "velho" }, searchParams: {} })).rejects.toThrow(
			"REDIRECT:/b/novo/cadastro",
		);
	});
});
