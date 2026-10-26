import type { PoolClient } from "pg";

export type PushSubscriptionReason = "not_allowed" | "invalid_input";

type OutcomeRow = { ok: boolean; reason: string | null };

// Motivo fora da lista é bug da função SQL: lança em vez de repassar texto livre ao chamador.
function outcome<R extends string>(fn: string, row: OutcomeRow | undefined, reasons: readonly R[]): { ok: true } | { ok: false; reason: R } {
	if (row?.ok) return { ok: true };
	const reason = reasons.find((known) => known === row?.reason);
	if (!reason) throw new Error(`unexpected ${fn} reason`);
	return { ok: false, reason };
}

// As funções SQL só aceitam o cliente da sessão: o perfil vem do contexto de withUserTransaction, nunca do argumento.
export async function registerPushSubscription(
	client: PoolClient,
	input: { endpoint: string; p256dh: string; auth: string; userAgent: string | null },
): Promise<{ ok: true } | { ok: false; reason: PushSubscriptionReason }> {
	const { rows } = await client.query<OutcomeRow>(
		"select ok, reason from register_push_subscription($1::text, $2::text, $3::text, $4::text)",
		[input.endpoint, input.p256dh, input.auth, input.userAgent],
	);
	return outcome("register_push_subscription", rows[0], ["not_allowed", "invalid_input"] as const);
}

export async function removePushSubscription(
	client: PoolClient,
	endpoint: string,
): Promise<{ ok: true } | { ok: false; reason: "not_allowed" }> {
	const { rows } = await client.query<OutcomeRow>("select ok, reason from remove_push_subscription($1::text)", [endpoint]);
	return outcome("remove_push_subscription", rows[0], ["not_allowed"] as const);
}

export async function isPushSubscriptionActive(client: PoolClient, endpoint: string): Promise<boolean> {
	const { rows } = await client.query<{ active: boolean }>("select push_subscription_active($1::text) as active", [endpoint]);
	return rows[0]?.active === true;
}
