import { beforeEach, describe, expect, it, vi } from "vitest";

const BUREAU_ID = "00000000-0000-4000-8000-0000000000b1";
const NEW_ID = "00000000-0000-4000-8000-000000000003";
const PASSWORD = "twelve-character-password";

const state = vi.hoisted(() => ({
	role: "superadmin" as string,
	createBureau: vi.fn(),
	inviteBureauAdmin: vi.fn(),
	setBureauAdminCredentials: vi.fn(),
	sendInviteEmail: vi.fn(),
}));

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/auth/session", () => ({
	getRequiredSession: vi.fn(async () => ({
		userId: "00000000-0000-4000-8000-000000000001",
		role: state.role,
		bureauId: null,
		supportSessionId: null,
	})),
}));
vi.mock("@/lib/auth/invite", () => ({ sendInviteEmail: state.sendInviteEmail }));
vi.mock("@/lib/bureaus/queries", () => ({
	createBureau: state.createBureau,
	inviteBureauAdmin: state.inviteBureauAdmin,
	setBureauAdminCredentials: state.setBureauAdminCredentials,
	setBureauStatus: vi.fn(),
	updateBureau: vi.fn(),
}));

import { createBureau, inviteBureauAdmin, setBureauAdminCredentials } from "./bureaus";

const newBureau = {
	name: "Bureau Novo",
	slug: "bureau-novo",
	adminName: "Maria Souza",
	adminEmail: "maria@example.test",
};
const invite = { bureauId: BUREAU_ID, name: "Maria Souza", email: "maria@example.test" };

beforeEach(() => {
	vi.clearAllMocks();
	state.role = "superadmin";
	state.createBureau.mockResolvedValue({ ok: true, id: BUREAU_ID, adminEmail: "maria@example.test" });
	state.inviteBureauAdmin.mockResolvedValue({ ok: true, userId: NEW_ID });
	state.setBureauAdminCredentials.mockResolvedValue({ ok: true });
	state.sendInviteEmail.mockResolvedValue(true);
});

describe("createBureau", () => {
	it("sends no e-mail when the admin gets a password", async () => {
		const result = await createBureau({ ...newBureau, adminPassword: PASSWORD });

		expect(result).toEqual({ error: null, id: BUREAU_ID });
		expect(state.createBureau).toHaveBeenCalledTimes(1);
		expect(state.sendInviteEmail).not.toHaveBeenCalled();
	});

	it("sends the invite e-mail when the password is blank", async () => {
		const result = await createBureau({ ...newBureau, adminPassword: "" });

		expect(result).toEqual({ error: null, id: BUREAU_ID });
		expect(state.sendInviteEmail).toHaveBeenCalledWith("maria@example.test");
	});
});

describe("inviteBureauAdmin", () => {
	it("sends no e-mail when a password is set", async () => {
		const result = await inviteBureauAdmin({ ...invite, password: PASSWORD });

		expect(result).toEqual({ error: null, id: NEW_ID });
		expect(state.sendInviteEmail).not.toHaveBeenCalled();
	});

	it("sends the e-mail without a password", async () => {
		expect(await inviteBureauAdmin(invite)).toEqual({ error: null, id: NEW_ID });
		expect(state.sendInviteEmail).toHaveBeenCalledWith("maria@example.test");
	});

	it("tells to use Definir senha when the admin exists and a password was given", async () => {
		state.inviteBureauAdmin.mockResolvedValue({ ok: false, reason: "already_member" });

		expect((await inviteBureauAdmin({ ...invite, password: PASSWORD })).error).toBe(
			"Este usuário já existe. Use Definir senha.",
		);
		expect((await inviteBureauAdmin(invite)).error).toBe("Este usuário já ativou a conta.");
	});

	it("rejects a short password before the query", async () => {
		const result = await inviteBureauAdmin({ ...invite, password: "short" });

		expect(result.error).toBe("A senha deve ter ao menos 12 caracteres.");
		expect(state.inviteBureauAdmin).not.toHaveBeenCalled();
	});
});

describe("setBureauAdminCredentials", () => {
	const input = { bureauId: BUREAU_ID, email: "maria@example.test", password: PASSWORD };

	it("denies everyone but the superadmin before the query", async () => {
		for (const role of ["bureau_admin", "operator", "client"]) {
			state.role = role;
			expect((await setBureauAdminCredentials(input)).error).toBe(
				"Você não tem permissão para gerenciar Bureaus.",
			);
		}
		expect(state.setBureauAdminCredentials).not.toHaveBeenCalled();
	});

	it("rejects a short password and a bad bureau id", async () => {
		expect((await setBureauAdminCredentials({ ...input, password: "short" })).error).toBe(
			"A senha deve ter ao menos 12 caracteres.",
		);
		expect((await setBureauAdminCredentials({ ...input, bureauId: "abc" })).error).toBeTruthy();
		expect(state.setBureauAdminCredentials).not.toHaveBeenCalled();
	});

	it("passes a null password to only force the change", async () => {
		expect(await setBureauAdminCredentials({ ...input, password: "" })).toEqual({ error: null });
		expect(state.setBureauAdminCredentials).toHaveBeenCalledWith(
			expect.anything(),
			{ bureauId: BUREAU_ID, email: "maria@example.test", password: null },
		);
	});

	it("returns the not-found message when the admin is unknown or has no access", async () => {
		state.setBureauAdminCredentials.mockResolvedValue({ ok: false, reason: "not_found" });

		expect((await setBureauAdminCredentials(input)).error).toBe(
			"Administrador não encontrado, ou ainda sem acesso. Defina uma senha.",
		);
	});
});
