import { Pool, types } from "pg";

import { config } from "@/lib/config";

// int8 -> number: Better Auth rate_limit.last_request (ms epoch) needs a number, not a string.
// Safe: the only bigint column is rate_limit.last_request; counts are cast ::int.
types.setTypeParser(20, Number);

export const pool = new Pool({
  connectionString: config.databaseUrl,
  max: Number(process.env.PG_POOL_MAX ?? 10),
  connectionTimeoutMillis: 5_000,
  query_timeout: 10_000,
});

pool.on("error", () => {
  console.error("PostgreSQL pool connection error");
});
