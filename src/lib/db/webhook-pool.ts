import { Pool } from "pg";

import { readWebhookDatabaseUrl } from "@/lib/config";

// Pool da role app_webhook, a única com EXECUTE em apply_asaas_payment (migração 014).
// Lazy: só o webhook usa; o build e os demais caminhos não exigem DATABASE_WEBHOOK_URL.
let webhookPool: Pool | undefined;

export function getWebhookPool(): Pool {
  if (!webhookPool) {
    webhookPool = new Pool({
      connectionString: readWebhookDatabaseUrl(process.env),
      max: Number(process.env.PG_WEBHOOK_POOL_MAX ?? 3),
      connectionTimeoutMillis: 5_000,
      query_timeout: 10_000,
    });
    webhookPool.on("error", () => {
      console.error("PostgreSQL webhook pool connection error");
    });
  }
  return webhookPool;
}
