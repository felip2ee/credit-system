import { Pool } from "pg";

import { readWebhookDatabaseUrl } from "@/lib/config";

// Pool da role app_webhook: webhook do Asaas (EXECUTE em apply_asaas_payment, migração 014), webhook da
// WhatsApp Cloud API e worker de notificações (EXECUTE em claim_notifications, complete_notification,
// apply_whatsapp_status e record_notification_opt_out, migração 020).
// Lazy: só esses caminhos usam; o build e os demais não exigem DATABASE_WEBHOOK_URL.
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
