// runDispatch de ponta a ponta: fila real (app_runtime enfileira, app_dispatch pega e conclui), WhatsApp pelo
// driver fake e e-mail com sendMail simulado. claim_notifications é global: cada teste afirma só sobre os próprios ids.
import { randomBytes, randomUUID } from "node:crypto";

import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
	Object.assign(process.env, {
		DATABASE_URL: process.env.TEST_DATABASE_URL ?? "postgres://app_runtime:test@localhost:54329/credit_system_test",
		DATABASE_WEBHOOK_URL: process.env.TEST_DATABASE_WEBHOOK_URL ?? "postgres://app_webhook:test@localhost:54329/credit_system_test",
		DISPATCH_DATABASE_URL: process.env.TEST_DATABASE_DISPATCH_URL ?? "postgres://app_dispatch:test@localhost:54329/credit_system_test",
		BETTER_AUTH_SECRET: "0123456789abcdef0123456789abcdef",
		BETTER_AUTH_URL: "http://localhost:3000",
		DOCUMENT_ROOT: "/tmp/reino-test-documents",
		CLAMAV_HOST: "localhost",
		CLAMAV_PORT: "3310",
		SMTP_HOST: "smtp.example.test",
		SMTP_PORT: "465",
		SMTP_SECURE: "true",
		SMTP_USER: "credit-system",
		SMTP_PASS: "test-password",
		WHATSAPP_DRIVER: "fake",
		WHATSAPP_PHONE_NUMBER_ID: "123456789",
		WHATSAPP_APP_SECRET: "a".repeat(32),
		WHATSAPP_VERIFY_TOKEN: "v".repeat(32),
		WEB_PUSH_VAPID_PUBLIC_KEY: "A".repeat(87),
		WEB_PUSH_VAPID_PRIVATE_KEY: "B".repeat(43),
		WEB_PUSH_VAPID_SUBJECT: "mailto:ops@example.test",
	});
});

const mailer = vi.hoisted(() => ({ sendMail: vi.fn(), senderDomain: vi.fn() }));
vi.mock("@/lib/email/mailer", () => mailer);
const webPush = vi.hoisted(() => ({ sendNotification: vi.fn() }));
vi.mock("web-push", () => webPush);
vi.mock("next/headers", () => ({
	headers: () => {
		throw new Error("no request scope");
	},
}));

import { pool } from "@/lib/db/pool";
import { withUserTransaction } from "@/lib/db/transaction";
import { getDispatchPool } from "@/lib/db/dispatch-pool";
import { getWebhookPool } from "@/lib/db/webhook-pool";
import { TEST_DATABASE_OWNER_URL } from "@/test/db-env";
import { seedClientProfile, seedTenant, type SeededTenant } from "@/test/seed";

import { registerPushSubscription } from "./push-subscriptions";
import { acquireClaimLock, releaseClaimLock } from "./claim-lock.test-util";
import { runDispatch } from "./dispatch";
import { enqueueNotification } from "./queries";
import type { NotificationChannel } from "./types";

const owner = new Pool({ connectionString: TEST_DATABASE_OWNER_URL, max: 4 });

let tenant: SeededTenant;
const created: string[] = [];

const rand = () => randomBytes(6).toString("hex");
const email = () => `${rand()}@example.test`;
const phone = () => `+55119${Math.floor(10000000 + Math.random() * 89999999)}`;

beforeAll(acquireClaimLock, 120_000);

beforeAll(async () => {
	tenant = await seedTenant(owner, "Notif Dispatch");
});

// Linhas de teste são imutáveis (sem DELETE): encerra as que sobraram para não vazarem para o claim de outro teste.
afterAll(async () => {
	await owner.query(
		`update notifications
        set status = 'suppressed', recipient = null, params = null, lease_id = null, locked_until = null
      where id = any($1::uuid[]) and status in ('pending', 'sending')`,
		[created],
	);
	await Promise.all([owner.end(), pool.end(), getWebhookPool().end(), getDispatchPool().end()]);
	await releaseClaimLock();
});

// Comportamento do e-mail por destinatário; o padrão é enviar.
type MailBehavior = (to: string) => Promise<{ messageId: string }>;
const behaviors = new Map<string, MailBehavior>();
const sentTo = () => mailer.sendMail.mock.calls.map(([input]) => (input as { to: string }).to);

beforeEach(() => {
	behaviors.clear();
	mailer.sendMail.mockReset().mockImplementation(({ to }: { to: string }) => {
		const behavior = behaviors.get(to);
		return behavior ? behavior(to) : Promise.resolve({ messageId: `<mail-${rand()}@example.test>` });
	});
	mailer.senderDomain.mockReset().mockReturnValue("rainha.example.test");
	webPush.sendNotification.mockReset().mockResolvedValue({ statusCode: 201 });
	vi.spyOn(console, "info").mockImplementation(() => {});
	vi.spyOn(console, "warn").mockImplementation(() => {});
});

async function enqueue(channel: NotificationChannel, recipient = channel === "email" ? email() : phone()) {
	const identity = tenant.bureauAdmin;
	const result = await withUserTransaction(identity, (client) =>
		enqueueNotification(client, identity, {
			templateKey: "platform_test",
			channel,
			recipient,
			params: {},
			idempotencyKey: randomUUID(),
		}),
	);
	if (!result.ok) throw new Error(result.reason);
	created.push(result.id);
	return { id: result.id, recipient };
}

const rowOf = async (id: string) =>
	(
		await owner.query(
			`select status, attempts, recipient, params, provider_message_id, last_error_code, lease_id,
              next_attempt_at > now() + interval '30 seconds' as backs_off
         from notifications where id = $1`,
			[id],
		)
	).rows[0];

const eventKinds = async (id: string) =>
	(await owner.query<{ kind: string }>("select kind from notification_events where notification_id = $1 order by id", [id])).rows.map(
		(r) => r.kind,
	);

describe("runDispatch", () => {
	it("sends an e-mail and a WhatsApp message: pending -> sent, provider id stored, payload erased", async () => {
		const mail = await enqueue("email");
		const wa = await enqueue("whatsapp");

		const result = await runDispatch();

		expect(result.sent).toBeGreaterThanOrEqual(2);
		expect(result.claimed).toBeGreaterThanOrEqual(result.sent);
		expect(sentTo()).toContain(mail.recipient);
		const mailRow = await rowOf(mail.id);
		expect(mailRow).toMatchObject({ status: "sent", recipient: null, params: null, lease_id: null });
		expect(mailRow.provider_message_id).toMatch(/^<mail-/);
		const waRow = await rowOf(wa.id);
		expect(waRow).toMatchObject({ status: "sent", recipient: null, params: null });
		expect(waRow.provider_message_id).toMatch(/^fake-wamid-/);
		expect(await eventKinds(mail.id)).toEqual(["queued", "sent"]);
	});

	it("reschedules a transient failure with backoff and records attempt_failed", async () => {
		const { id, recipient } = await enqueue("email");
		behaviors.set(recipient, () => Promise.reject(Object.assign(new Error("timeout"), { code: "ETIMEDOUT" })));

		const result = await runDispatch();

		expect(result.retried).toBeGreaterThanOrEqual(1);
		expect(await rowOf(id)).toMatchObject({
			status: "pending",
			attempts: 1,
			last_error_code: "smtp_timeout",
			recipient,
			backs_off: true,
		});
		expect(await eventKinds(id)).toEqual(["queued", "attempt_failed"]);
	});

	it("turns a permanent failure into failed and keeps the payload for a manual retry", async () => {
		const { id, recipient } = await enqueue("email");
		behaviors.set(recipient, () => Promise.reject(Object.assign(new Error("rejected"), { responseCode: 550 })));

		const result = await runDispatch();

		expect(result.failed).toBeGreaterThanOrEqual(1);
		expect(await rowOf(id)).toMatchObject({ status: "failed", last_error_code: "smtp_rejected", recipient });
		expect(await eventKinds(id)).toEqual(["queued", "failed"]);
	});

	it("retries with unexpected_error when the channel throws", async () => {
		const { id } = await enqueue("email");
		mailer.senderDomain.mockImplementation(() => {
			throw new Error("boom");
		});

		await runDispatch();

		expect(await rowOf(id)).toMatchObject({ status: "pending", last_error_code: "unexpected_error" });
	});

	it("suppresses an opted-out recipient without calling the channel", async () => {
		const { id, recipient } = await enqueue("whatsapp");
		await getWebhookPool().query("select record_notification_opt_out('whatsapp', $1)", [recipient]);
		const mail = await enqueue("email");

		const result = await runDispatch();

		expect(result.suppressed).toBeGreaterThanOrEqual(1);
		expect(await rowOf(id)).toMatchObject({ status: "suppressed", last_error_code: "opted_out", recipient: null, provider_message_id: null });
		expect(await eventKinds(id)).toEqual(["queued", "suppressed"]);
		expect((await rowOf(mail.id)).status).toBe("sent");
	});

	it("counts a stale lease and never throws", async () => {
		const { id, recipient } = await enqueue("email");
		behaviors.set(recipient, async () => {
			// Outro processo assumiu a linha enquanto o envio estava em andamento.
			await owner.query("update notifications set lease_id = gen_random_uuid() where id = $1", [id]);
			return { messageId: "<stale@example.test>" };
		});

		const result = await runDispatch();

		expect(result.stale).toBeGreaterThanOrEqual(1);
		expect((await rowOf(id)).status).toBe("sending");
	});

	it("stops without claiming when the time budget is spent", async () => {
		const { id } = await enqueue("email");

		const result = await runDispatch({ budgetMs: 0 });

		expect(result).toEqual({ claimed: 0, sent: 0, retried: 0, failed: 0, suppressed: 0, stale: 0, errors: 0 });
		expect((await rowOf(id)).status).toBe("pending");
	});

	it("keeps claiming batches until the queue is empty", async () => {
		const ids = await Promise.all(Array.from({ length: 3 }, () => enqueue("email")));

		const result = await runDispatch({ batchSize: 1 });

		expect(result.claimed).toBeGreaterThanOrEqual(3);
		for (const { id } of ids) expect((await rowOf(id)).status).toBe("sent");
	});

	it("logs ids, channels and codes only, never the recipient", async () => {
		const { recipient } = await enqueue("email");
		behaviors.set(recipient, () => Promise.reject(Object.assign(new Error(`failed for ${recipient}`), { code: "ETIMEDOUT" })));

		await runDispatch();

		const logged = JSON.stringify([...vi.mocked(console.warn).mock.calls, ...vi.mocked(console.info).mock.calls]);
		expect(logged).not.toContain(recipient);
		expect(logged).toContain("smtp_timeout");
	});

	describe("push", () => {
		// Cliente com um aparelho inscrito e um aviso de comissão na fila (evento 3), enfileirado como o gatilho do banco faz.
		async function queuedPush() {
			const client = await seedClientProfile(owner, tenant.bureau.id);
			const endpoint = `https://fcm.googleapis.com/fcm/send/${randomUUID()}`;
			const identity = { userId: client.userId, role: "client" as const, bureauId: client.bureauId };
			const registered = await withUserTransaction(identity, (c) =>
				registerPushSubscription(c, {
					endpoint,
					p256dh: randomBytes(65).toString("base64url"),
					auth: randomBytes(16).toString("base64url"),
					userAgent: "test-agent",
				}),
			);
			expect(registered).toEqual({ ok: true });
			const reference = `test_push:${randomUUID()}`;
			const { rows } = await owner.query<{ n: number }>(
				"select enqueue_push_for_profile($1, 'commission_received', '/portal/afiliacao', $2, $3) as n",
				[client.userId, reference, reference],
			);
			expect(rows[0].n).toBe(1);
			const { rows: queued } = await owner.query<{ id: string }>("select id from notifications where reference = $1", [reference]);
			created.push(queued[0].id);
			return { id: queued[0].id, userId: client.userId, endpoint };
		}
		const subscriptionCount = async (userId: string) =>
			Number((await owner.query("select count(*) as n from push_subscriptions where profile_id = $1", [userId])).rows[0].n);

		it("sends a push notice: pending -> sent, no recipient kept", async () => {
			const { id, endpoint } = await queuedPush();

			const result = await runDispatch();

			expect(result.sent).toBeGreaterThanOrEqual(1);
			expect(await rowOf(id)).toMatchObject({ status: "sent", recipient: null, params: null, lease_id: null, provider_message_id: `push:${id}` });
			const [subscription, payload, options] = webPush.sendNotification.mock.calls[0];
			expect(subscription.endpoint).toBe(endpoint);
			expect(JSON.parse(payload)).toEqual({ title: "Rainha Cred", body: "Você recebeu uma comissão", url: "/portal/afiliacao" });
			expect(options).toMatchObject({ TTL: 86400 });
		});

		it("deletes the subscription and fails the notice as push_gone on a 410", async () => {
			const { id, userId } = await queuedPush();
			webPush.sendNotification.mockRejectedValue(Object.assign(new Error("gone"), { statusCode: 410 }));

			await runDispatch();

			expect(await rowOf(id)).toMatchObject({ status: "failed", last_error_code: "push_gone" });
			expect(await subscriptionCount(userId)).toBe(0);
		});
	});
});
