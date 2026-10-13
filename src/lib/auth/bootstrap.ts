// Creates the platform superadmin on first start of an empty database.
// Never touches an existing user: after the first boot the password belongs to
// the user (changed through the app), and the env/secret may be removed.
import { randomUUID } from "node:crypto";

import { hashPassword } from "better-auth/crypto";

import { writeAuditEvent } from "@/lib/audit/write";
import { withUserTransaction } from "@/lib/db/transaction";

type Env = Record<string, string | undefined>;
export type SuperadminOutcome = "disabled" | "exists" | "created";

const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

export async function ensureSuperadmin(env: Env = process.env): Promise<SuperadminOutcome> {
  const email = env.SUPERADMIN_EMAIL?.trim().toLowerCase();
  if (!email) return "disabled";
  if (!EMAIL.test(email)) throw new Error("SUPERADMIN_EMAIL must be a valid email");

  const password = env.SUPERADMIN_PASSWORD;
  if (!password) {
    throw new Error("SUPERADMIN_PASSWORD is required when SUPERADMIN_EMAIL is set");
  }
  if (password.length < 12 || password.length > 128) {
    throw new Error("SUPERADMIN_PASSWORD must be between 12 and 128 characters");
  }

  const id = randomUUID();
  const passwordHash = await hashPassword(password);

  return withUserTransaction({ userId: id, role: "admin" }, async (client) => {
    // Serialises concurrent replicas; the existence check must run under it.
    await client.query("select pg_advisory_xact_lock(hashtext('credit-system-superadmin'))");
    const existing = await client.query('select 1 from "user" where lower(email) = $1', [email]);
    if (existing.rowCount) return "exists";

    await client.query(
      'insert into "user" (id, name, email, email_verified, two_factor_enabled) values ($1, $2, $3, true, false)',
      [id, "Superadmin", email],
    );
    await client.query(
      "insert into account (id, issuer, account_id, provider_id, user_id, password, updated_at) values ($1, 'local:credential', $2, 'credential', $2, $3, now())",
      [randomUUID(), id, passwordHash],
    );
    await client.query(
      "insert into profiles (id, auth_user_id, full_name, email, role) values ($1::uuid, $1::text, $2, $3, 'admin')",
      [id, "Superadmin", email],
    );
    await writeAuditEvent(client, {
      actorId: id,
      action: "superadmin.bootstrap",
      targetTable: "profiles",
      targetId: id,
    });
    return "created";
  });
}
