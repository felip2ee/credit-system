import { Client } from "pg";

import { TEST_DATABASE_OWNER_URL } from "@/test/db-env";

// claim_notifications é global entre Bureaus: arquivos de teste em paralelo roubariam as linhas um do outro.
const CLAIM_LOCK_KEY = 20_260_020;

let client: Client | null = null;

/** Serializa os arquivos que chamam claim_notifications (lock de sessão em conexão dedicada). */
export async function acquireClaimLock(): Promise<void> {
	client = new Client({ connectionString: TEST_DATABASE_OWNER_URL });
	await client.connect();
	await client.query("select pg_advisory_lock($1)", [CLAIM_LOCK_KEY]);
	// Com o lock, ninguém mais enfileira nem faz claim: encerra o que arquivos anteriores deixaram claimable (sem DELETE; linhas imutáveis).
	// Sem isso, pendentes órfãos (ex.: avisos research_released dos testes de pedidos) lotam o limite do claim e escondem as linhas do teste.
	await client.query(
		`update notifications
        set status = 'suppressed', recipient = null, params = null, lease_id = null, locked_until = null
      where status in ('pending', 'sending')`,
	);
}

export async function releaseClaimLock(): Promise<void> {
	await client?.end(); // fechar a sessão libera o lock
	client = null;
}
