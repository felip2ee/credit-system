"use server";

import { revalidatePath } from "next/cache";
import type { PoolClient } from "pg";
import { z } from "zod";

import { writeAuditEvent } from "@/lib/audit/write";
import { setTemporaryCredentials } from "@/lib/auth/credentials";
import { createInvite, sendInviteEmail } from "@/lib/auth/invite";
import { getRequiredSession, type RequiredSession } from "@/lib/auth/session";
import { hasPermission } from "@/lib/db/permissions";
import { withUserTransaction } from "@/lib/db/transaction";
import { optionalPasswordSchema } from "@/lib/validators/password";

const staffRoleSchema = z.enum(["bureau_admin", "operator"]);
const userIdSchema = z.string().uuid();
const inviteSchema = z.object({
	fullName: z.string().trim().min(3, "Nome muito curto."),
	email: z.string().trim().toLowerCase().email("E-mail inválido."),
	role: staffRoleSchema,
	password: optionalPasswordSchema,
});

const NOT_ALLOWED = "Sem permissão para gerenciar a equipe.";
const NOT_FOUND = "Usuário não encontrado.";
const LAST_ADMIN = "O Bureau precisa de ao menos um administrador ativo.";
const PROMOTE_ONLY = "Só é possível promover operador a administrador.";
const EMAIL_FAILED = "Convite registrado, mas o e-mail falhou. Use Reenviar.";

type TeamSession = RequiredSession & { bureauId: string };

async function requireTeamManager(): Promise<TeamSession | null> {
	// Sessão expirada lança SessionAccessError: a action devolve { error } em vez de lançar ao cliente.
	let session: RequiredSession;
	try {
		session = await getRequiredSession();
	} catch {
		return null;
	}
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

// Trava os admins ativos que conseguem entrar (têm conta; convite pendente não conta) e confere se sobra outro além do alvo.
async function hasOtherActiveAdmin(
	client: PoolClient,
	bureauId: string,
	userId: string,
): Promise<boolean> {
	const { rows } = await client.query<{ id: string }>(
		`select p.id from profiles p
      where p.bureau_id = $1 and p.role = 'bureau_admin' and p.is_active
        and exists (select 1 from account a where a.user_id = p.auth_user_id)
        for update of p`,
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
	password?: string;
}): Promise<{ error: string | null; email?: string; invited?: boolean }> {
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
					? parsed.data.password
						? "Esse usuário já faz parte da equipe. Use Definir senha."
						: "Esse usuário já faz parte da equipe."
					: "E-mail já em uso.",
		};
	}

	revalidatePath("/settings/users");
	// Com senha temporária o membro entra direto: não há convite por e-mail.
	if (parsed.data.password) {
		return { error: null, email: parsed.data.email, invited: false };
	}
	const error = await sendOrReport(parsed.data.email);
	return error
		? { error }
		: { error: null, email: parsed.data.email, invited: true };
}

// password ausente = só forçar a troca no próximo login. O gateway SQL só aceita operador do Bureau.
export async function setTeamMemberCredentials(input: {
	userId: string;
	password?: string;
}): Promise<{ error: string | null }> {
	const session = await requireTeamManager();
	if (!session) return { error: NOT_ALLOWED };
	const userId = userIdSchema.safeParse(input.userId);
	const password = optionalPasswordSchema.safeParse(input.password);
	if (!userId.success) return { error: "Usuário inválido." };
	if (!password.success)
		return { error: password.error.issues[0]?.message ?? "Senha inválida." };
	if (userId.data === session.userId)
		return {
			error:
				'Para alterar a sua senha, use "Esqueci a senha" na tela de login.',
		};

	try {
		const outcome = await withUserTransaction(session, (client) =>
			setTemporaryCredentials(client, session.userId, {
				targetId: userId.data,
				bureauId: session.bureauId,
				password: password.data ?? null,
			}),
		);
		if (!outcome.ok)
			return { error: "Só é possível definir a senha de operadores do seu Bureau." };
	} catch {
		return { error: "Falha ao definir a senha." };
	}
	revalidatePath("/settings/users");
	return { error: null };
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

// Só promove operador a administrador: o banco recusa qualquer outra troca de papel.
export async function setUserRole(input: {
	userId: string;
	role: "bureau_admin" | "operator";
}): Promise<{ error: string | null }> {
	const session = await requireTeamManager();
	if (!session) return { error: NOT_ALLOWED };
	const userId = userIdSchema.safeParse(input.userId);
	if (!userId.success) return { error: "Dados inválidos." };
	if (input.role !== "bureau_admin") return { error: PROMOTE_ONLY };
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
			if (target.role === "bureau_admin") return null;
			await client.query(
				"update profiles set role = 'bureau_admin'::user_role, updated_at = now() where id = $1",
				[userId.data],
			);
			await client.query('delete from "session" where user_id = $1', [
				userId.data,
			]);
			await writeAuditEvent(client, {
				actorId: session.userId,
				action: "user.role_change",
				targetTable: "profiles",
				targetId: userId.data,
				metadata: { role: "bureau_admin", previousRole: target.role },
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
