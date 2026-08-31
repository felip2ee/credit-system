import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  Object.assign(process.env, {
    DATABASE_URL: "postgres://app_runtime:test@localhost:54329/credit_system",
    BETTER_AUTH_SECRET: "0123456789abcdef0123456789abcdef",
    BETTER_AUTH_URL: "http://localhost:3000",
    DOCUMENT_ROOT: "D:/credit-system/.data/documents",
    CLAMAV_HOST: "localhost",
    CLAMAV_PORT: "3310",
    SMTP_HOST: "smtp.example.test",
    SMTP_PORT: "465",
    SMTP_SECURE: "true",
    SMTP_USER: "credit-system",
    SMTP_PASS: "test-password",
  });
});

import { pool } from "@/lib/db/pool";
import { withUserTransaction, type DbIdentity } from "@/lib/db/transaction";
import { getPortalOpportunityDetail } from "./queries";

const admin: DbIdentity = { userId: randomUUID(), role: "admin" };
const owner: DbIdentity = { userId: randomUUID(), role: "client" };
const otherClient: DbIdentity = { userId: randomUUID(), role: "client" };
const crmClientId = randomUUID();
const opportunityId = randomUUID();

describe.sequential("opportunity PostgreSQL queries", () => {
  beforeAll(async () => {
    await withUserTransaction(admin, async (client) => {
      await client.query(
        'insert into "user" (id, name, email) values ($1, $2, $3), ($4, $5, $6), ($7, $8, $9)',
        [
          admin.userId, "Opportunity admin", `${admin.userId}@example.test`,
          owner.userId, "Opportunity owner", `${owner.userId}@example.test`,
          otherClient.userId, "Other client", `${otherClient.userId}@example.test`,
        ],
      );
      await client.query(
        "insert into profiles (id, auth_user_id, full_name, email, role) values ($1, $1, $2, $3, 'admin'), ($4, $4, $5, $6, 'client'), ($7, $7, $8, $9, 'client')",
        [
          admin.userId, "Opportunity admin", `${admin.userId}@example.test`,
          owner.userId, "Opportunity owner", `${owner.userId}@example.test`,
          otherClient.userId, "Other client", `${otherClient.userId}@example.test`,
        ],
      );
      await client.query(
        "insert into crm_clients (id, type, name, user_id, created_by) values ($1, 'PF', 'Portal owner', $2, $3)",
        [crmClientId, owner.userId, admin.userId],
      );
      await client.query(
        "insert into opportunities (id, crm_client_id, created_by) values ($1, $2, $3)",
        [opportunityId, crmClientId, admin.userId],
      );
      await client.query(
        `insert into opportunity_documents (opportunity_id, doc_type, label, status, scan_result)
         values ($1, 'clean', 'Documento limpo', 'uploaded', 'clean'),
                ($1, 'unsafe', 'Documento não verificado', 'uploaded', null)`,
        [opportunityId],
      );
    });
  });

  afterAll(async () => {
    await pool.end();
  });

  it("returns only the owner opportunity and clean documents", async () => {
    const own = await getPortalOpportunityDetail(owner, opportunityId);
    expect(own?.documents.map((document) => document.label)).toEqual([
      "Documento limpo",
    ]);
    await expect(getPortalOpportunityDetail(otherClient, opportunityId)).resolves.toBeNull();
  });
});
