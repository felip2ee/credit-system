// Migrations 032 e 038: modelos de e-mail da plataforma com a identidade e a paleta Rainha Cred.
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import { Pool } from "pg";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mailer = vi.hoisted(() => ({ sendMail: vi.fn(), senderDomain: vi.fn() }));
vi.mock("@/lib/email/mailer", () => mailer);
const cfg = vi.hoisted(() => ({ betterAuthUrl: "" }));
vi.mock("@/lib/config", () => ({ config: cfg }));

import { BRAND_COLORS } from "@/lib/brand/tokens";
import { contrastRatio } from "@/lib/brand/contrast";
import { TEST_DATABASE_OWNER_URL } from "@/test/db-env";

import { sendEmailNotification } from "./channels/email";
import { renderEmail } from "./render";
import type { ClaimedNotification } from "./types";

const owner = new Pool({ connectionString: TEST_DATABASE_OWNER_URL, max: 2 });
afterAll(() => owner.end());

const SEEDED_KEYS = ["scr_authorization", "email_verification", "research_released", "platform_test"];
const SAMPLE_PARAMS: Record<string, Record<string, string>> = {
	scr_authorization: { clientName: "Maria", authorizedName: "Empresa X", code: "123456", url: "https://x.test/a/abc" },
	email_verification: { clientName: "Maria", url: "https://x.test/v/abc" },
	research_released: { clientName: "Maria", url: "https://x.test/p/abc" },
	platform_test: {},
};
const OLD_BRAND = /Rainha do Crédito|Eliane Moreira|Reino do Crédito|instagram/i;
const SUPPORT_EMAIL = "suporte@rainhacred.com.br";
const LOGO_PATH = "/brand/rainha-cred/logo/rainha-cred-logo-completa-transparente.png";
const SITE_URL = "https://app.example.test";

type Row = { key: string; version: number; status: string; params: string[]; email_subject: string; email_html: string; email_text: string };

async function templates(status: "active" | "retired"): Promise<Row[]> {
	const { rows } = await owner.query<Row>(
		`select key, version, status, params, email_subject, email_html, email_text from notification_templates
      where channel = 'email' and status = $1 and key = any($2) order by key`,
		[status, SEEDED_KEYS],
	);
	return rows;
}

describe("seeded e-mail templates after migrations 032 and 038", () => {
	it("keeps the older versions retired and a new version active, with the same params", async () => {
		const active = await templates("active");
		const retired = await templates("retired");
		const sorted = [...SEEDED_KEYS].sort();
		expect(active.map((t) => [t.key, t.version])).toEqual(sorted.map((key) => [key, 3]));
		expect(retired.map((t) => [t.key, t.version])).toEqual(sorted.flatMap((key) => [[key, 1], [key, 2]]));
		for (const t of active) for (const r of retired.filter((x) => x.key === t.key)) expect(t.params).toEqual(r.params);
	});

	it("keeps subject and text of version 2 and drops the old palette from the HTML", async () => {
		const retired = await templates("retired");
		for (const t of await templates("active")) {
			const v2 = retired.find((r) => r.key === t.key && r.version === 2)!;
			expect(t.email_subject).toBe(v2.email_subject);
			expect(t.email_text).toBe(v2.email_text);
			expect(t.email_html).not.toMatch(/#(007A76|009C97|FCEDCE|122C2B|F4EFE4|4A5E5D)/i);
		}
	});

	it("has no old brand, phone or Instagram, and shows Rainha Cred with the support e-mail", async () => {
		for (const t of await templates("active")) {
			for (const body of [t.email_subject, t.email_html, t.email_text]) expect(body).not.toMatch(OLD_BRAND);
			for (const body of [t.email_html, t.email_text]) {
				expect(body).toContain("Rainha Cred");
				expect(body).toContain(SUPPORT_EMAIL);
				expect(body).not.toMatch(/\(63\)|contato@/);
			}
		}
	});

	it("uses the brand tokens, Arial and the logo by absolute URL", async () => {
		for (const t of await templates("active")) {
			const html = t.email_html.toUpperCase();
			for (const color of [BRAND_COLORS.primary, BRAND_COLORS.cream, BRAND_COLORS.ink, BRAND_COLORS.brand]) {
				expect(html, `${t.key} ${color}`).toContain(color);
			}
			expect(t.email_html).toContain("font-family:Arial, sans-serif");
			expect(t.email_html).toContain(`src="{{siteUrl}}${LOGO_PATH}"`);
			expect(t.email_html).not.toMatch(/font-size:1[0-3]px/);
		}
	});

	it("renders the absolute logo src and fills every marker", async () => {
		for (const t of await templates("active")) {
			const rendered = renderEmail(t, { ...SAMPLE_PARAMS[t.key], siteUrl: SITE_URL });
			expect(rendered.html).toContain(`src="${SITE_URL}${LOGO_PATH}"`);
			expect(rendered.html).not.toMatch(/\{\{|\}\}/);
			expect(rendered.text).not.toMatch(/\{\{|\}\}/);
		}
	});

	it("keeps the SCR code, the action URL and the failure-safe fallback link", async () => {
		const scr = (await templates("active")).find((t) => t.key === "scr_authorization")!;
		const rendered = renderEmail(scr, { ...SAMPLE_PARAMS.scr_authorization, siteUrl: SITE_URL });
		expect(rendered.html).toContain("123456");
		expect(rendered.html).toContain('href="https://x.test/a/abc"');
		expect(rendered.text).toContain("Seu código de confirmação: 123456");
		expect(rendered.text).toContain("https://x.test/a/abc");
	});

	it("keeps the logo file in the public kit", () => {
		expect(existsSync(path.join(process.cwd(), "public", LOGO_PATH))).toBe(true);
	});

	it("keeps text contrast at 4.5:1 or more", () => {
		const pairs = [
			[BRAND_COLORS.primaryForeground, BRAND_COLORS.primary],
			[BRAND_COLORS.ink, BRAND_COLORS.cream],
			[BRAND_COLORS.ink, BRAND_COLORS.background],
			[BRAND_COLORS.mutedForeground, BRAND_COLORS.background],
			[BRAND_COLORS.cream, BRAND_COLORS.ink],
			[BRAND_COLORS.primary, BRAND_COLORS.background],
		];
		for (const [fg, bg] of pairs) expect(contrastRatio(fg, bg), `${fg} on ${bg}`).toBeGreaterThanOrEqual(4.5);
	});
});

describe("migration 032 and customized templates", () => {
	it("does not replace a template whose active version is no longer the seeded one", async () => {
		const sql = readFileSync(path.join(process.cwd(), "db/migrations/032_rainha_cred_email_templates.sql"), "utf8");
		const client = await owner.connect();
		try {
			await client.query("begin");
			await client.query("update notification_templates set status = 'retired' where key = 'email_verification' and channel = 'email' and status = 'active'");
			await client.query(
				`insert into notification_templates (key, channel, version, params, email_subject, email_html, email_text)
         values ('email_verification', 'email', 4, array['clientName', 'url'], 'Personalizado', '<p>{{clientName}} {{url}}</p>', '{{clientName}} {{url}}')`,
			);
			await client.query(sql);
			const { rows } = await client.query<{ version: number; email_subject: string }>(
				"select version, email_subject from notification_templates where key = 'email_verification' and channel = 'email' and status = 'active'",
			);
			expect(rows).toEqual([{ version: 4, email_subject: "Personalizado" }]);
			const { rows: all } = await client.query("select 1 from notification_templates where key = 'email_verification' and channel = 'email'");
			expect(all).toHaveLength(4);
		} finally {
			await client.query("rollback");
			client.release();
		}
	});
});

describe("migration 038 and customized templates", () => {
	it("does not replace a template whose active version is no longer the one from 032", async () => {
		const sql = readFileSync(path.join(process.cwd(), "db/migrations/038_rainha_cred_email_palette.sql"), "utf8");
		const client = await owner.connect();
		try {
			await client.query("begin");
			await client.query("update notification_templates set status = 'retired' where key = 'email_verification' and channel = 'email' and status = 'active'");
			await client.query(
				`insert into notification_templates (key, channel, version, params, email_subject, email_html, email_text)
         values ('email_verification', 'email', 4, array['clientName', 'url'], 'Personalizado', '<p>{{clientName}} {{url}}</p>', '{{clientName}} {{url}}')`,
			);
			await client.query(sql);
			const { rows } = await client.query<{ version: number; email_subject: string }>(
				"select version, email_subject from notification_templates where key = 'email_verification' and channel = 'email' and status = 'active'",
			);
			expect(rows).toEqual([{ version: 4, email_subject: "Personalizado" }]);
		} finally {
			await client.query("rollback");
			client.release();
		}
	});
});

describe("sendEmailNotification and the site URL", () => {
	const notification: ClaimedNotification = {
		id: "0b8f6f0e-1111-2222-3333-444455556666",
		lease_id: "l-1",
		channel: "email",
		recipient: "maria@exemplo.com",
		params: { name: "Maria" },
		attempts: 1,
		opted_out: false,
		template_key: "platform_test",
		template_version: 2,
		template_params: ["name"],
		email_subject: "Olá {{name}}",
		email_html: '<img src="{{siteUrl}}/logo.png"><p>{{name}}</p>',
		email_text: "{{name}}",
		wa_template_name: null,
		wa_language: null,
	};

	beforeEach(() => {
		mailer.sendMail.mockReset().mockResolvedValue({ messageId: "<provider@id>" });
		mailer.senderDomain.mockReset().mockReturnValue("rainha.example.test");
		cfg.betterAuthUrl = `${SITE_URL}/`;
	});

	afterEach(() => vi.unstubAllEnvs());

	it("fills {{siteUrl}} from BETTER_AUTH_URL without a trailing slash", async () => {
		expect(await sendEmailNotification(notification)).toMatchObject({ ok: true });
		expect(mailer.sendMail.mock.calls[0][0].html).toBe(`<img src="${SITE_URL}/logo.png"><p>Maria</p>`);
	});

	it("returns config_error when the site URL is empty", async () => {
		cfg.betterAuthUrl = "";
		expect(await sendEmailNotification(notification)).toMatchObject({ ok: false, code: "config_error" });
	});

	it("does not let a queued parameter replace the site URL", async () => {
		await sendEmailNotification({ ...notification, params: { name: "Maria", siteUrl: "https://evil.test" } });
		expect(mailer.sendMail.mock.calls[0][0].html).toContain(`src="${SITE_URL}/logo.png"`);
	});
});
