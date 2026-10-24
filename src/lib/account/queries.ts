// Contas de cliente (M5). Toda regra vive nas funções SQL da migração 021; aqui só chamada, tipos e checagem do motivo.
// registerClient e confirmEmailVerification rodam sem sessão (pool): as funções são SECURITY DEFINER e o token é a credencial.
import type { PoolClient } from "pg";

import { pool } from "@/lib/db/pool";

export type RegisterFailure =
	| "rate_limited"
	| "invalid_input"
	| "bureau_not_found"
	| "outdated_terms"
	| "document_in_use"
	| "email_in_use";

export type RegisterClientInput = {
	slug: string;
	type: "PF" | "PJ";
	name: string;
	documentDigits: string;
	email: string;
	phoneE164: string;
	passwordHash: string;
	termsVersion: number;
	privacyVersion: number;
	ip: string | null;
	userAgent: string | null;
	emailToken: string;
	siteUrl: string;
};

export type AccountResult<R extends string> = { ok: true } | { ok: false; reason: R };

type OutcomeRow = { ok: boolean; reason: string | null };

const REGISTER_FAILURES: readonly RegisterFailure[] = [
	"rate_limited",
	"invalid_input",
	"bureau_not_found",
	"outdated_terms",
	"document_in_use",
	"email_in_use",
];

// Motivo fora da lista do tipo é bug da função SQL: lança em vez de repassar texto livre ao chamador.
function accountResult<R extends string>(fn: string, row: OutcomeRow | undefined, reasons: readonly R[]): AccountResult<R> {
	if (row?.ok) return { ok: true };
	const reason = reasons.find((known) => known === row?.reason);
	if (!reason) throw new Error(`unexpected ${fn} reason`);
	return { ok: false, reason };
}

export async function registerClient(
	input: RegisterClientInput,
): Promise<{ ok: true; userId: string } | { ok: false; reason: RegisterFailure }> {
	const { rows } = await pool.query<OutcomeRow & { user_id: string | null }>(
		"select ok, reason, user_id from register_client($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::inet, $11, $12, $13)",
		[
			input.slug,
			input.type,
			input.name,
			input.documentDigits,
			input.email,
			input.phoneE164,
			input.passwordHash,
			input.termsVersion,
			input.privacyVersion,
			input.ip,
			input.userAgent,
			input.emailToken,
			input.siteUrl,
		],
	);
	const row = rows[0];
	if (row?.ok && row.user_id) return { ok: true, userId: row.user_id };
	const reason = REGISTER_FAILURES.find((known) => known === row?.reason);
	if (row?.ok || !reason) throw new Error("unexpected registerClient reason");
	return { ok: false, reason };
}

// Leitura do limite por IP (sem gravar): a ação recusa antes de gastar CPU no hash da senha.
export async function isRegisterIpAllowed(ip: string | null): Promise<boolean> {
	const { rows } = await pool.query<{ allowed: boolean }>("select client_register_ip_allowed($1::inet) as allowed", [ip]);
	return rows[0]?.allowed === true;
}

export async function confirmEmailVerification(token: string): Promise<AccountResult<"invalid" | "expired">> {
	const { rows } = await pool.query<OutcomeRow>("select ok, reason from confirm_email_verification($1)", [token]);
	return accountResult("confirmEmailVerification", rows[0], ["invalid", "expired"]);
}

export type LegalKind = "terms" | "privacy";
export type LegalDocument = { kind: LegalKind; version: number; title: string; bodyMd: string; publishedAt: Date };

type LegalRow = { kind: LegalKind; version: number; title: string; body_md: string; published_at: Date };

// Sem sessão (páginas públicas de cadastro e termos).
export async function getCurrentLegalDocuments(): Promise<Record<LegalKind, LegalDocument>> {
	const { rows } = await pool.query<LegalRow>(
		`select distinct on (kind) kind, version, title, body_md, published_at
       from legal_documents
      where published_at <= now() and kind in ('terms', 'privacy')
      order by kind, version desc`,
	);
	const byKind = new Map(rows.map((row) => [row.kind, row]));
	const terms = byKind.get("terms");
	const privacy = byKind.get("privacy");
	if (!terms || !privacy) throw new Error("legal documents missing");
	const toDocument = (row: LegalRow): LegalDocument => ({
		kind: row.kind,
		version: row.version,
		title: row.title,
		bodyMd: row.body_md,
		publishedAt: row.published_at,
	});
	return { terms: toDocument(terms), privacy: toDocument(privacy) };
}

export type ClientAccountStatus = {
	emailVerified: boolean;
	phoneE164: string | null;
	phoneVerified: boolean;
	notificationChannel: "email" | "whatsapp";
	termsAccepted: boolean;
	documentMasked: string | null;
};

type StatusRow = {
	email_verified: boolean;
	phone_e164: string | null;
	phone_verified: boolean;
	notification_channel: "email" | "whatsapp";
	document_digits: string | null;
	terms_accepted: boolean;
};

const CPF_LENGTH = 11;
const CNPJ_LENGTH = 14;

// CPF ***.456.789-** · CNPJ **.345.678/0001-**: nunca o número inteiro.
function maskDocument(digits: string | null): string | null {
	if (digits?.length === CPF_LENGTH) return `***.${digits.slice(3, 6)}.${digits.slice(6, 9)}-**`;
	if (digits?.length === CNPJ_LENGTH) return `**.${digits.slice(2, 5)}.${digits.slice(5, 8)}/${digits.slice(8, 12)}-**`;
	return null;
}

// Roda com a identidade do cliente: o RLS limita as linhas.
export async function getClientAccountStatus(client: PoolClient, userId: string): Promise<ClientAccountStatus> {
	const { rows } = await client.query<StatusRow>(
		`select u.email_verified, p.phone_e164, p.phone_verified_at is not null as phone_verified, p.notification_channel,
       (select h.document_digits from holders h where h.client_profile_id = p.id order by h.created_at limit 1)
         as document_digits,
       not exists (
         select 1
           from (select distinct on (d.kind) d.id from legal_documents d
                  where d.published_at <= now() and d.kind in ('terms', 'privacy')
                  order by d.kind, d.version desc) cur
          where not exists (select 1 from legal_acceptances a where a.profile_id = p.id and a.document_id = cur.id)
       ) as terms_accepted
  from profiles p
  join "user" u on u.id = p.auth_user_id
 where p.id = $1`,
		[userId],
	);
	const row = rows[0];
	if (!row) throw new Error("client profile not found");
	return {
		emailVerified: row.email_verified,
		phoneE164: row.phone_e164,
		phoneVerified: row.phone_verified,
		notificationChannel: row.notification_channel,
		termsAccepted: row.terms_accepted,
		documentMasked: maskDocument(row.document_digits),
	};
}

async function callAccountFunction<R extends string>(
	client: PoolClient,
	fn: string,
	sql: string,
	params: unknown[],
	reasons: readonly R[],
): Promise<AccountResult<R>> {
	const { rows } = await client.query<OutcomeRow>(sql, params);
	return accountResult(fn, rows[0], reasons);
}

export function requestEmailVerification(client: PoolClient, userId: string, token: string, siteUrl: string) {
	return callAccountFunction(
		client,
		"requestEmailVerification",
		"select ok, reason from request_email_verification($1, $2, $3)",
		[userId, token, siteUrl],
		["not_allowed", "already_verified", "invalid_input", "cooldown", "too_many"] as const,
	);
}

export function requestPhoneVerification(client: PoolClient, userId: string, phoneE164: string, code: string) {
	return callAccountFunction(
		client,
		"requestPhoneVerification",
		"select ok, reason from request_phone_verification($1, $2, $3)",
		[userId, phoneE164, code],
		["not_allowed", "email_not_verified", "invalid_input", "already_verified", "cooldown", "too_many"] as const,
	);
}

export function confirmPhoneVerification(client: PoolClient, userId: string, code: string) {
	return callAccountFunction(
		client,
		"confirmPhoneVerification",
		"select ok, reason from confirm_phone_verification($1, $2)",
		[userId, code],
		["not_allowed", "invalid", "expired", "too_many_attempts"] as const,
	);
}

export function acceptLegalDocuments(
	client: PoolClient,
	userId: string,
	input: { termsVersion: number; privacyVersion: number; ip: string | null; userAgent: string | null },
) {
	return callAccountFunction(
		client,
		"acceptLegalDocuments",
		"select ok, reason from accept_legal_documents($1, $2, $3, $4::inet, $5)",
		[userId, input.termsVersion, input.privacyVersion, input.ip, input.userAgent],
		["not_allowed", "outdated"] as const,
	);
}

export function setNotificationChannel(client: PoolClient, userId: string, channel: "email" | "whatsapp") {
	return callAccountFunction(
		client,
		"setNotificationChannel",
		"select ok, reason from set_notification_channel($1, $2)",
		[userId, channel],
		["not_allowed", "invalid_input", "phone_not_verified"] as const,
	);
}
