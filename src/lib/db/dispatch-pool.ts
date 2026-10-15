import { Pool } from "pg";

import { readDispatchDatabaseUrl } from "@/lib/config";

// Pool da role app_dispatch: só o worker de notificações (EXECUTE em claim_notifications e
// complete_notification, migração 020). Lazy: o build e os demais caminhos não exigem DISPATCH_DATABASE_URL.
let dispatchPool: Pool | undefined;

export function getDispatchPool(): Pool {
  if (!dispatchPool) {
    dispatchPool = new Pool({
      connectionString: readDispatchDatabaseUrl(process.env),
      max: Number(process.env.PG_DISPATCH_POOL_MAX ?? 3),
      connectionTimeoutMillis: 5_000,
      query_timeout: 10_000,
    });
    dispatchPool.on("error", () => {
      console.error("PostgreSQL dispatch pool connection error");
    });
  }
  return dispatchPool;
}
