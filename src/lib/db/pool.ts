import { Pool } from "pg";

import { config } from "@/lib/config";

export const pool = new Pool({
  connectionString: config.databaseUrl,
  max: 1,
  connectionTimeoutMillis: 5_000,
  query_timeout: 10_000,
});

pool.on("error", () => {
  console.error("PostgreSQL pool connection error");
});
