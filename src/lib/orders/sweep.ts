// Identidades de sistema de todos os Bureaus ativos, não só dos que têm pedido devido: a retenção LGPD vale para todos.
// A lista sai sob RLS: o superadmin enxerga os Bureaus; o perfil de sistema aparece para a equipe do próprio Bureau.
import { withUserTransaction, type DbIdentity } from "@/lib/db/transaction";

// Só leitura de listagem: a RLS exige um usuário no contexto, mas nada é gravado com este id.
const NIL_USER_ID = "00000000-0000-0000-0000-000000000000";
const LISTER: DbIdentity = { userId: NIL_USER_ID, role: "superadmin", bureauId: null };

export async function listSweepIdentities(): Promise<DbIdentity[]> {
	const bureauIds = await withUserTransaction(LISTER, async (client) => {
		const { rows } = await client.query<{ id: string }>("select id from bureaus where status = 'active' order by id");
		return rows.map((row) => row.id);
	});
	const identities: DbIdentity[] = [];
	for (const bureauId of bureauIds) {
		const asStaff: DbIdentity = { userId: NIL_USER_ID, role: "operator", bureauId };
		const system = await withUserTransaction(asStaff, async (client) => {
			const { rows } = await client.query<{ id: string }>("select id from profiles where bureau_id = $1 and is_system", [bureauId]);
			return rows[0]?.id;
		});
		if (system) identities.push({ userId: system, role: "operator", bureauId });
	}
	return identities;
}
