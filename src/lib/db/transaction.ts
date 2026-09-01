import type { PoolClient } from "pg";

import { pool } from "./pool";

export type DbIdentity = {
  userId: string;
  role: "admin" | "consultant" | "client";
};

export async function withUserTransaction<T>(
  identity: DbIdentity,
  work: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  let started = false;
  let releaseError: Error | boolean | undefined;

  try {
    await client.query("begin");
    started = true;
    await client.query("select set_config('app.user_id', $1, true)", [
      identity.userId,
    ]);
    await client.query("select set_config('app.user_role', $1, true)", [
      identity.role,
    ]);

    const result = await work(client);
    await client.query("commit");
    started = false;
    return result;
  } catch (error) {
    if (started) {
      try {
        await client.query("rollback");
      } catch (rollbackError) {
        releaseError = rollbackError instanceof Error ? rollbackError : true;
      }
    }
    throw error;
  } finally {
    client.release(releaseError);
  }
}
