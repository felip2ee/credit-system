import { beforeEach, describe, expect, it, vi } from "vitest";

const s = vi.hoisted(() => ({
	client: { query: vi.fn() },
	consultPF: vi.fn(),
	consultPJ: vi.fn(),
	executeConsultation: vi.fn(),
	claimOrders: vi.fn(),
	getExecutionPlan: vi.fn(),
	completeOrder: vi.fn(),
	failOrder: vi.fn(),
	retryOrderLater: vi.fn(),
	refreshDossierStatus: vi.fn(),
	recordHolderEvent: vi.fn(),
}));

vi.mock("@/lib/db/transaction", () => ({ withUserTransaction: async (_i: unknown, work: (c: unknown) => unknown) => work(s.client) }));
vi.mock("@/lib/deps/client", () => ({ getDepsClient: () => ({ consultPF: s.consultPF, consultPJ: s.consultPJ }) }));
vi.mock("@/lib/consultations/service", () => ({ executeConsultation: s.executeConsultation }));
vi.mock("@/lib/dossiers/queries", () => ({ refreshDossierStatus: s.refreshDossierStatus }));
vi.mock("@/lib/holders/queries", () => ({ recordHolderEvent: s.recordHolderEvent }));
vi.mock("./queries", () => ({
	claimOrders: s.claimOrders,
	getExecutionPlan: s.getExecutionPlan,
	completeOrder: s.completeOrder,
	failOrder: s.failOrder,
	retryOrderLater: s.retryOrderLater,
}));

import { DepsScrPendingError } from "@/lib/deps/errors";

import { runOrderNow, runReadyOrders } from "./execute";

const identity = { userId: "sys", role: "operator" as const, bureauId: "b1" };
const DOSSIER = "d1";
const MAIN_DOC = "12345678909";
const PARTNER_DOC = "98765432100";

const member = (over: Record<string, unknown>) => ({
	consultationId: "c-main",
	type: "PJ",
	document: MAIN_DOC,
	name: "Empresa Teste",
	product: "Smart PJ 010",
	holderId: "h-main",
	status: "pending_authorization",
	scrEmail: "titular@example.com",
	isMain: true,
	...over,
});
const partner = member({ consultationId: "c-p1", type: "PF", document: PARTNER_DOC, name: "Socio", product: "Smart PF 002", holderId: "h-p1", isMain: false });

const plan = (members: unknown[]) => ({ order: { dossierId: DOSSIER, mode: "online", attempts: 1, kind: "PJ_FULL" }, members });

let logs: string;

beforeEach(() => {
	vi.clearAllMocks();
	logs = "";
	for (const method of ["log", "warn", "error"] as const) {
		vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
			logs += JSON.stringify(args);
		});
	}
	s.claimOrders.mockResolvedValue([{ dossierId: DOSSIER, attempts: 1 }]);
	s.getExecutionPlan.mockResolvedValue(plan([member({})]));
	s.consultPJ.mockResolvedValue({ body: { segredo: "corpo" } });
	s.consultPF.mockResolvedValue({ body: { segredo: "corpo" } });
	s.executeConsultation.mockResolvedValue({ status: "completed", canonical: {} });
	s.completeOrder.mockResolvedValue("completed");
	s.retryOrderLater.mockResolvedValue("ready");
	s.client.query.mockResolvedValue({ rows: [] });
});

// Atualizações que levam uma consulta a 'error' (literal no SQL ou parâmetro de markConsultation).
const errorUpdates = () =>
	s.client.query.mock.calls.filter(([sql, params]) => String(sql).includes("'error'") || (params as unknown[] | undefined)?.[1] === "error");

describe("runOrderNow", () => {
	it("returns not_claimed when the claim comes back empty", async () => {
		s.claimOrders.mockResolvedValue([]);

		expect(await runOrderNow(identity, DOSSIER)).toBe("not_claimed");
		expect(s.claimOrders).toHaveBeenCalledWith(s.client, 1, DOSSIER);
		expect(s.consultPJ).not.toHaveBeenCalled();
	});

	it("completes the order when the main consultation completes", async () => {
		expect(await runOrderNow(identity, DOSSIER)).toBe("completed");

		expect(s.consultPJ).toHaveBeenCalledWith(MAIN_DOC, {
			product: "Smart PJ 010",
			reuseExisting: false,
			authorization: { name: "Empresa Teste", email: "titular@example.com" },
			autorizacaoScr: true,
		});
		expect(s.recordHolderEvent).toHaveBeenCalledWith(
			s.client,
			"sys",
			"h-main",
			expect.objectContaining({ eventType: "query.executed", title: "Consulta realizada", description: "Smart PJ 010" }),
		);
		expect(s.completeOrder).toHaveBeenCalledWith(s.client, identity, DOSSIER);
	});

	it("retry after lease uses reuseExisting", async () => {
		s.claimOrders.mockResolvedValue([{ dossierId: DOSSIER, attempts: 2 }]);

		await runOrderNow(identity, DOSSIER);

		expect(s.consultPJ).toHaveBeenCalledWith(MAIN_DOC, expect.objectContaining({ reuseExisting: true }));
	});

	it("skips a member that is already completed", async () => {
		s.getExecutionPlan.mockResolvedValue(plan([member({ status: "completed" }), partner]));

		await runOrderNow(identity, DOSSIER);

		expect(s.consultPJ).not.toHaveBeenCalled();
		expect(s.consultPF).toHaveBeenCalledOnce();
		expect(s.completeOrder).toHaveBeenCalledOnce();
	});

	it("a network error on the main consultation schedules a retry and skips the partners", async () => {
		s.getExecutionPlan.mockResolvedValue(plan([member({}), partner]));
		s.consultPJ.mockRejectedValue(new TypeError(`fetch failed for ${MAIN_DOC}`));

		expect(await runOrderNow(identity, DOSSIER)).toBe("retry");

		expect(s.retryOrderLater).toHaveBeenCalledWith(s.client, identity, DOSSIER, 1);
		expect(s.consultPF).not.toHaveBeenCalled();
		expect(s.completeOrder).not.toHaveBeenCalled();
		expect(errorUpdates()).toHaveLength(0);
	});

	it("marks the main consultation as error on the last attempt, before retryOrderLater fails the order", async () => {
		s.claimOrders.mockResolvedValue([{ dossierId: DOSSIER, attempts: 5 }]);
		s.consultPJ.mockRejectedValue(new Error("boom"));
		s.retryOrderLater.mockResolvedValue("failed");

		expect(await runOrderNow(identity, DOSSIER)).toBe("failed");

		expect(errorUpdates()).toHaveLength(1);
		expect(s.client.query.mock.invocationCallOrder.at(-1)).toBeLessThan(s.retryOrderLater.mock.invocationCallOrder[0]);
	});

	it.each([
		["no_data", { status: "no_data" }],
		["a pending SCR", new DepsScrPendingError()],
	])("%s on the main consultation fails the order with deps_no_data", async (_name, outcome) => {
		if (outcome instanceof Error) s.consultPJ.mockRejectedValue(outcome);
		else s.executeConsultation.mockResolvedValue(outcome);

		expect(await runOrderNow(identity, DOSSIER)).toBe("failed");

		expect(errorUpdates()).toHaveLength(1);
		expect(s.failOrder).toHaveBeenCalledWith(s.client, identity, DOSSIER, "deps_no_data");
		expect(s.completeOrder).not.toHaveBeenCalled();
	});

	it("payload_incompatible on the main consultation fails the order with deps_incompatible", async () => {
		s.getExecutionPlan.mockResolvedValue(plan([member({}), partner]));
		s.executeConsultation.mockResolvedValue({ status: "payload_incompatible", errors: [] });

		expect(await runOrderNow(identity, DOSSIER)).toBe("failed");

		expect(s.failOrder).toHaveBeenCalledWith(s.client, identity, DOSSIER, "deps_incompatible");
		expect(s.consultPF).not.toHaveBeenCalled();
	});

	it("a partner with an error does not stop the order from completing", async () => {
		s.getExecutionPlan.mockResolvedValue(plan([member({}), partner]));
		s.consultPF.mockRejectedValue(new Error("boom"));

		expect(await runOrderNow(identity, DOSSIER)).toBe("completed");

		expect(errorUpdates()).toHaveLength(1);
		expect(s.failOrder).not.toHaveBeenCalled();
		expect(s.completeOrder).toHaveBeenCalledOnce();
	});

	it("a partner without data is marked error and the order still completes", async () => {
		s.getExecutionPlan.mockResolvedValue(plan([member({}), partner]));
		s.executeConsultation.mockResolvedValueOnce({ status: "completed", canonical: {} }).mockResolvedValueOnce({ status: "no_data" });

		expect(await runOrderNow(identity, DOSSIER)).toBe("completed");

		expect(errorUpdates()).toHaveLength(1);
	});

	it("returns failed when the capture was clawed back", async () => {
		s.completeOrder.mockResolvedValue("failed");

		expect(await runOrderNow(identity, DOSSIER)).toBe("failed");
	});

	it("never logs a document or the DEPS body", async () => {
		s.getExecutionPlan.mockResolvedValue(plan([member({}), partner]));
		s.consultPF.mockRejectedValue(new Error(`falha ${PARTNER_DOC}`));

		await runOrderNow(identity, DOSSIER);
		s.consultPJ.mockRejectedValue(new Error(`falha ${MAIN_DOC}`));
		await runOrderNow(identity, DOSSIER);

		expect(logs).not.toContain(MAIN_DOC);
		expect(logs).not.toContain(PARTNER_DOC);
		expect(logs).not.toContain("corpo");
		for (const [, params] of s.client.query.mock.calls) expect(JSON.stringify(params)).not.toContain(MAIN_DOC);
	});
});

describe("runReadyOrders", () => {
	it("runs every claimed order and reports each outcome", async () => {
		s.claimOrders.mockResolvedValue([
			{ dossierId: "d1", attempts: 1 },
			{ dossierId: "d2", attempts: 1 },
		]);
		s.consultPJ.mockResolvedValueOnce({ body: {} }).mockRejectedValueOnce(new Error("boom"));

		expect(await runReadyOrders(identity, 5)).toEqual([
			{ dossierId: "d1", outcome: "completed" },
			{ dossierId: "d2", outcome: "retry" },
		]);
		expect(s.claimOrders).toHaveBeenCalledWith(s.client, 5, undefined);
	});
});
