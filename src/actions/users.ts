"use server";

import { revalidatePath } from "next/cache";
import type { PoolClient } from "pg";
import { z } from "zod";

import { writeAuditEvent } from "@/lib/audit/write";
import { createInvite, sendInviteEmail } from "@/lib/auth/invite";
import { getRequiredSession, type RequiredSession } from "@/lib/auth/session";
import { hasPermission } from "@/lib/db/permissions";
import { withUserTransaction } from "@/lib/db/transaction";

const staffRoleSchema = z.enum(["bureau_admin", "operator"]);
const userIdSchema = z.string().uuid();
const inviteSchema = z.object({
	fullName: z.string().trim().min(3, "Nome muito curto."),
	email: z.string().trim().toLowerCase().email("E-mail inválido."),
	role: staffRoleSchema,
});

const NOT_ALLOWED = "Sem permissão para gerenciar a equipe.";
const NOT_FOUND = "Usuário não encontrado.";
const LAST_ADMIN = "O Bureau precisa de ao menos um administrador ativo.";
const EMAIL_FAILED = "Convite registrado, mas o e-mail falhou. Use Reenviar.";

type TeamSession = RequiredSession & { bureauId: string };

async function requireTeamManager(): Promise<TeamSession | null> {
	const session = await getRequiredSession();
	if (!hasPermission(session, "users:manage") || !session.bureauId) return null;
	return { ...session, bureauId: session.bureauId };
}

// Trava o perfil alvo (só equipe do próprio Bureau) para decidir e escrever sem corrida.
async function lockStaffTarget(
	client: PoolClient,
	bureauId: string,
	userId: string,
): Promise<{ role: string; isActive: boolean } | null> {
	const { rows } = await client.query<{ role: string; isActive: boolean }>(
		`select role::text as role, is_active as "isActive"
       from profiles
      where id = $1 and bureau_id = $2 and role in ('bureau_admin', 'operator')
        for update`,
		[userId, bureauId],
	);
	return rows[0] ?? null;
}

// Trava os admins ativos e confere se sobra outro além do alvo.
async function hasOtherActiveAdmin(
	client: PoolClient,
	bureauId: string,
	userId: string,
): Promise<boolean> {
	const { rows } = await client.query<{ id: string }>(
		`select id from profiles
      where bureau_id = $1 and role = 'bureau_admin' and is_active
        for update`,
		[bureauId],
	);
	return rows.some((row) => row.id !== userId);
}

async function sendOrReport(email: string): Promise<string | null> {
	return (await sendInviteEmail(email)) ? null : EMAIL_FAILED;
}

export async function inviteTeamMember(input: {
	fullName: string;
	email: string;
	role: "bureau_admin" | "operator";
}): Promise<{ error: string | null; email?: string }> {
	const session = await requireTeamManager();
	if (!session) return { error: NOT_ALLOWED };
	const parsed = inviteSchema.safeParse(input);
	if (!parsed.success)
		return { error: parsed.error.issues[0]?.message ?? "Dados inválidos." };

	let outcome;
	try {
		outcome = await withUserTransaction(session, (client) =>
			createInvite(client, session.userId, {
				...parsed.data,
				bureauId: session.bureauId,
			}),
		);
	} catch {
		return { error: "Falha ao registrar o convite." };
	}
	if (!outcome.ok) {
		return {
			error:
				outcome.reason === "already_member"
					? "Esse usuário já faz parte da equipe."
					: "E-mail já em uso.",
		};
	}

	revalidatePath("/settings/users");
	const error = await sendOrReport(parsed.data.email);
	return error ? { error } : { error: null, email: parsed.data.email };
}

export async function resendTeamInvite(input: {
	userId: string;
}): Promise<{ error: string | null }> {
	const session = await requireTeamManager();
	if (!session) return { error: NOT_ALLOWED };
	const userId = userIdSchema.safeParse(input.userId);
	if (!userId.success) return { error: "Usuário inválido." };

	let email: string;
	try {
		const result = await withUserTransaction(session, async (client) => {
			const { rows } = await client.query<{
				fullName: string;
				email: string;
				role: string;
			}>(
				`select full_name as "fullName", email, role::text as role
           from profiles
          where id = $1 and bureau_id = $2 and role in ('bureau_admin', 'operator')`,
				[userId.data, session.bureauId],
			);
			const member = rows[0];
			if (!member) return null;
			const role = staffRoleSchema.parse(member.role);
			const outcome = await createInvite(client, session.userId, {
				email: member.email,
				fullName: member.fullName,
				role,
				bureauId: session.bureauId,
			});
			return { member, outcome };
		});
		if (!result) return { error: NOT_FOUND };
		if (!result.outcome.ok) return { error: "Esse usuário já ativou a conta." };
		email = result.member.email;
	} catch {
		return { error: "Falha ao reenviar o convite." };
	}

	return { error: await sendOrReport(email) };
}

export async function setUserRole(input: {
	userId: string;
	role: "bureau_admin" | "operator";
}): Promise<{ error: string | null }> {
	const session = await requireTeamManager();
	if (!session) return { error: NOT_ALLOWED };
	const userId = userIdSchema.safeParse(input.userId);
	const role = staffRoleSchema.safeParse(input.role);
	if (!userId.success || !role.success) return { error: "Dados inválidos." };
	if (userId.data === session.userId)
		return { error: "Você não pode alterar o próprio perfil." };

	try {
		const error = await withUserTransaction(session, async (client) => {
			const target = await lockStaffTarget(
				client,
				session.bureauId,
				userId.data,
			);
			if (!target) return NOT_FOUND;
			if (target.role === role.data) return null;
			if (
				target.role === "bureau_admin" &&
				target.isActive &&
				!(await hasOtherActiveAdmin(client, session.bureauId, userId.data))
			) {
				return LAST_ADMIN;
			}
			await client.query(
				"update profiles set role = $1::user_role, updated_at = now() where id = $2",
				[role.data, userId.data],
			);
			await client.query('delete from "session" where user_id = $1', [
				userId.data,
			]);
			await writeAuditEvent(client, {
				actorId: session.userId,
				action: "user.role_change",
				targetTable: "profiles",
				targetId: userId.data,
				metadata: { role: role.data, previousRole: target.role },
			});
			return null;
		});
		if (error) return { error };
	} catch {
		return { error: "Falha ao alterar o perfil." };
	}
	revalidatePath("/settings/users");
	return { error: null };
}

export async function setUserActive(input: {
	userId: string;
	isActive: boolean;
}): Promise<{ error: string | null }> {
	const session = await requireTeamManager();
	if (!session) return { error: NOT_ALLOWED };
	const userId = userIdSchema.safeParse(input.userId);
	if (!userId.success || typeof input.isActive !== "boolean")
		return { error: "Dados inválidos." };
	if (userId.data === session.userId && !input.isActive) {
		return { error: "Você não pode desativar a si mesmo." };
	}

	try {
		const error = await withUserTransaction(session, async (client) => {
			const target = await lockStaffTarget(
				client,
				session.bureauId,
				userId.data,
			);
			if (!target) return NOT_FOUND;
			if (
				!input.isActive &&
				target.role === "bureau_admin" &&
				target.isActive &&
				!(await hasOtherActiveAdmin(client, session.bureauId, userId.data))
			) {
				return LAST_ADMIN;
			}
			await client.query(
				"update profiles set is_active = $1, updated_at = now() where id = $2",
				[input.isActive, userId.data],
			);
			await client.query('delete from "session" where user_id = $1', [
				userId.data,
			]);
			await writeAuditEvent(client, {
				actorId: session.userId,
				action: input.isActive ? "user.activate" : "user.deactivate",
				targetTable: "profiles",
				targetId: userId.data,
			});
			return null;
		});
		if (error) return { error };
	} catch {
		return { error: "Falha ao alterar o usuário." };
	}
	revalidatePath("/settings/users");
	return { error: null };
}
