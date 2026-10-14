import { beforeEach, describe, expect, it, vi } from "vitest";

const ADMIN_ID = "00000000-0000-4000-8000-000000000001";
const OTHER_ID = "00000000-0000-4000-8000-000000000002";
const BUREAU_ID = "00000000-0000-4000-8000-0000000000b1";
const OTHER_BUREAU_ID = "00000000-0000-4000-8000-0000000000b2";

const state = vi.hoisted(() => ({
	query: vi.fn(),
	role: "bureau_admin" as string,
	createInvite: vi.fn(),
	sendInviteEmail: vi.fn(),
	writeAuditEvent: vi.fn(),
}));

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/auth/session", () => ({
	getRequiredSession: vi.fn(async () => ({
		userId: "00000000-0000-4000-8000-000000000001",
		role: state.role,
		bureauId: "00000000-0000-4000-8000-0000000000b1",
		supportSessionId: null,
	})),
}));
vi.mock("@/lib/db/transaction", () => ({
	withUserTransaction: vi.fn(async (_identity, work) =>
		work({ query: state.query }),
	),
}));
vi.mock("@/lib/audit/write", () => ({
	writeAuditEvent: state.writeAuditEvent,
}));
vi.mock("@/lib/auth/invite", () => ({
	createInvite: state.createInvite,
	sendInviteEmail: state.sendInviteEmail,
}));

import {
	inviteTeamMember,
	resendTeamInvite,
	setUserActive,
	setUserRole,
} from "./users";

const invite = {
	fullName: "Maria Souza",
	email: "maria@example.test",
	role: "operator" as const,
};

beforeEach(() => {
	vi.clearAllMocks();
	state.role = "bureau_admin";
	state.query.mockReset();
	state.createInvite.mockResolvedValue({
		ok: true,
		userId: OTHER_ID,
		resent: false,
	});
	state.sendInviteEmail.mockResolvedValue(true);
});

describe("permissions and validation", () => {
	it("rejects an operator before any query", async () => {
		state.role = "operator";
		const results = await Promise.all([
			inviteTeamMember(invite),
			resendTeamInvite({ userId: OTHER_ID }),
			setUserRole({ userId: OTHER_ID, role: "operator" }),
			setUserActive({ userId: OTHER_ID, isActive: false }),
		]);
		for (const result of results) expect(result.error).toBeTruthy();
		expect(state.query).not.toHaveBeenCalled();
		expect(state.createInvite).not.toHaveBeenCalled();
	});

	it("rejects a non-uuid userId and roles outside the enum", async () => {
		expect(
			(await setUserRole({ userId: "abc", role: "operator" })).error,
		).toBeTruthy();
		expect(
			(await setUserActive({ userId: "abc", isActive: true })).error,
		).toBeTruthy();
		expect((await resendTeamInvite({ userId: "abc" })).error).toBeTruthy();
		for (const role of ["superadmin", "client"]) {
			expect(
				(await setUserRole({ userId: OTHER_ID, role: role as "operator" }))
					.error,
			).toBeTruthy();
			expect(
				(await inviteTeamMember({ ...invite, role: role as "operator" })).error,
			).toBeTruthy();
		}
		expect(state.query).not.toHaveBeenCalled();
		expect(state.createInvite).not.toHaveBeenCalled();
	});
});

describe("inviteTeamMember", () => {
	it("uses session.bureauId even when the input carries another bureau", async () => {
		const result = await inviteTeamMember({
			...invite,
			bureauId: OTHER_BUREAU_ID,
		} as typeof invite);

		expect(result).toEqual({ error: null, email: "maria@example.test" });
		expect(state.createInvite).toHaveBeenCalledWith(
			expect.anything(),
			ADMIN_ID,
			expect.objectContaining({ bureauId: BUREAU_ID, role: "operator" }),
		);
		expect(state.sendInviteEmail).toHaveBeenCalledWith("maria@example.test");
	});

	it("keeps the invite and reports when the email fails", async () => {
		state.sendInviteEmail.mockResolvedValue(false);

		const result = await inviteTeamMember(invite);

		expect(result.error).toBe(
			"Convite registrado, mas o e-mail falhou. Use Reenviar.",
		);
		expect(state.createInvite).toHaveBeenCalledTimes(1);
	});

	it("maps email_in_use", async () => {
		state.createInvite.mockResolvedValue({ ok: false, reason: "email_in_use" });

		expect((await inviteTeamMember(invite)).error).toBe("E-mail já em uso.");
		expect(state.sendInviteEmail).not.toHaveBeenCalled();
	});
});

describe("resendTeamInvite", () => {
	it("resends to a pending member of the own bureau", async () => {
		state.query.mockResolvedValue({
			rows: [
				{
					fullName: "Maria Souza",
					email: "maria@example.test",
					role: "operator",
				},
			],
		});

		expect(await resendTeamInvite({ userId: OTHER_ID })).toEqual({
			error: null,
		});
		expect(state.createInvite).toHaveBeenCalledWith(
			expect.anything(),
			ADMIN_ID,
			expect.objectContaining({
				bureauId: BUREAU_ID,
				email: "maria@example.test",
			}),
		);
		expect(state.sendInviteEmail).toHaveBeenCalledWith("maria@example.test");
	});

	it("fails when the member is unknown", async () => {
		state.query.mockResolvedValue({ rows: [] });

		expect((await resendTeamInvite({ userId: OTHER_ID })).error).toBe(
			"Usuário não encontrado.",
		);
		expect(state.createInvite).not.toHaveBeenCalled();
	});
});

describe("setUserActive and setUserRole", () => {
	function target(role: string, adminIds: string[]) {
		state.query.mockImplementation(async (sql: string) => {
			if (sql.includes("for update") && sql.includes("role in (")) {
				return { rows: [{ role, isActive: true }] };
			}
			if (sql.includes("for update"))
				return { rows: adminIds.map((id) => ({ id })) };
			return { rows: [], rowCount: 1 };
		});
	}
	const wrote = () =>
		state.query.mock.calls.some(([sql]) =>
			/^\s*(update|delete)/i.test(sql as string),
		);

	it("blocks self-deactivation without writing", async () => {
		const result = await setUserActive({ userId: ADMIN_ID, isActive: false });

		expect(result.error).toBeTruthy();
		expect(wrote()).toBe(false);
	});

	it("blocks changing the own role", async () => {
		const result = await setUserRole({ userId: ADMIN_ID, role: "operator" });

		expect(result.error).toBeTruthy();
		expect(wrote()).toBe(false);
	});

	it("blocks deactivating the last active bureau_admin", async () => {
		target("bureau_admin", [OTHER_ID]);

		const result = await setUserActive({ userId: OTHER_ID, isActive: false });

		expect(result.error).toBe(
			"O Bureau precisa de ao menos um administrador ativo.",
		);
		expect(wrote()).toBe(false);
	});

	it("blocks demoting the last active bureau_admin", async () => {
		target("bureau_admin", [OTHER_ID]);

		const result = await setUserRole({ userId: OTHER_ID, role: "operator" });

		expect(result.error).toBe(
			"O Bureau precisa de ao menos um administrador ativo.",
		);
		expect(wrote()).toBe(false);
	});

	it("deactivates, revokes sessions and audits in the same transaction", async () => {
		target("operator", [ADMIN_ID]);

		expect(await setUserActive({ userId: OTHER_ID, isActive: false })).toEqual({
			error: null,
		});

		const sqls = state.query.mock.calls.map(([sql]) => sql as string);
		expect(sqls.some((s) => s.includes("is_active"))).toBe(true);
		expect(sqls.some((s) => s.includes('delete from "session"'))).toBe(true);
		expect(state.writeAuditEvent).toHaveBeenCalledWith(
			expect.objectContaining({ query: state.query }),
			expect.objectContaining({
				actorId: ADMIN_ID,
				action: "user.deactivate",
				targetId: OTHER_ID,
			}),
		);
	});

	it("demotes an admin when another active admin remains", async () => {
		target("bureau_admin", [OTHER_ID, ADMIN_ID]);

		expect(await setUserRole({ userId: OTHER_ID, role: "operator" })).toEqual({
			error: null,
		});
		expect(state.writeAuditEvent).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({
				action: "user.role_change",
				metadata: { role: "operator", previousRole: "bureau_admin" },
			}),
		);
	});

	it("reports a missing target", async () => {
		state.query.mockResolvedValue({ rows: [], rowCount: 0 });

		expect(
			(await setUserActive({ userId: OTHER_ID, isActive: true })).error,
		).toBe("Usuário não encontrado.");
		expect(state.writeAuditEvent).not.toHaveBeenCalled();
	});
});
