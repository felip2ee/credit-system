import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ query: vi.fn(), sendEmail: vi.fn() }));
vi.mock("@/lib/db/dispatch-pool", () => ({ getDispatchPool: () => ({ query: state.query }) }));
vi.mock("./channels/email", () => ({ sendEmailNotification: state.sendEmail }));
vi.mock("./channels/whatsapp", () => ({ sendWhatsappNotification: vi.fn() }));

import { runDispatch } from "./dispatch";

const claimed = {
	id: "n-1",
	lease_id: "l-1",
	channel: "email",
	recipient: "titular@example.test",
	params: { code: "123456" },
	opted_out: false,
};

describe("runDispatch unexpected errors", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		state.query
			.mockResolvedValueOnce({ rows: [claimed] })
			.mockResolvedValueOnce({ rows: [{ result: "applied" }] })
			.mockResolvedValueOnce({ rows: [] });
		vi.spyOn(console, "info").mockImplementation(() => {});
	});

	it("retries with unexpected_error and logs only the error name", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		state.sendEmail.mockRejectedValue(new TypeError("boom for titular@example.test code 123456"));

		const result = await runDispatch({ budgetMs: 1_000 });

		expect(result.retried).toBe(1);
		expect(state.query.mock.calls[1][1]).toEqual(["n-1", "l-1", "retry", null, "unexpected_error"]);
		const logged = JSON.stringify(warn.mock.calls);
		expect(logged).toContain("TypeError");
		expect(logged).not.toContain("titular@example.test");
		expect(logged).not.toContain("123456");
	});

	it("retries complete_notification once with the same lease after a send that worked", async () => {
		state.query.mockReset();
		state.query
			.mockResolvedValueOnce({ rows: [claimed] })
			.mockRejectedValueOnce(new Error("connection reset"))
			.mockResolvedValueOnce({ rows: [{ result: "applied" }] })
			.mockResolvedValueOnce({ rows: [] });
		state.sendEmail.mockResolvedValue({ ok: true, providerMessageId: "<m@x>" });

		const result = await runDispatch({ budgetMs: 1_000 });

		expect(result).toMatchObject({ sent: 1, errors: 0 });
		expect(state.query.mock.calls[1][1]).toEqual(state.query.mock.calls[2][1]);
		expect(state.query.mock.calls[1][1]).toEqual(["n-1", "l-1", "sent", "<m@x>", null]);
	});

	it("counts an error and logs a truthful message when complete fails twice", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		state.query.mockReset();
		state.query
			.mockResolvedValueOnce({ rows: [claimed] })
			.mockRejectedValueOnce(new Error("down"))
			.mockRejectedValueOnce(new Error("down"))
			.mockResolvedValueOnce({ rows: [] });
		state.sendEmail.mockResolvedValue({ ok: true, providerMessageId: "<m@x>" });

		const result = await runDispatch({ budgetMs: 1_000 });

		expect(result).toMatchObject({ sent: 0, errors: 1 });
		const logged = JSON.stringify(warn.mock.calls);
		expect(logged).toContain("resultado não gravado");
		expect(logged).not.toContain("envio falhou");
	});
});
