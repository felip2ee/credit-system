import { randomUUID } from "node:crypto";

import { Pool } from "pg";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  session: { current: null as unknown },
  requestPasswordReset: vi.fn(),
  revalidatePath: vi.fn(),
  afterCatalogRead: { current: null as null | (() => Promise<void>) },
}));

vi.hoisted(() => {
  Object.assign(process.env, {
    DATABASE_URL:
      process.env.TEST_DATABASE_URL ??
      "postgres://app_runtime:test@localhost:54329/credit_system_test",
    BETTER_AUTH_SECRET: "0123456789abcdef0123456789abcdef",
    BETTER_AUTH_URL: "http://localhost:3000",
    DOCUMENT_ROOT: "/tmp/reino-test-documents",
    CLAMAV_HOST: "localhost",
    CLAMAV_PORT: "3310",
    SMTP_HOST: "smtp.example.test",
    SMTP_PORT: "465",
    SMTP_SECURE: "true",
    SMTP_USER: "credit-system",
    SMTP_PASS: "test-password",
  });
});

vi.mock("next/headers", () => ({
  headers: () => new Headers({ "x-forwarded-for": "203.0.113.9", "user-agent": "vitest-agent" }),
}));
// Deixa o teste mudar o preço entre a leitura do catálogo e a reserva.
vi.mock("@/lib/bureaus/public", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/bureaus/public")>();
  return {
    ...real,
    getPublicCatalog: async (slug: string) => {
      const items = await real.getPublicCatalog(slug);
      await mocks.afterCatalogRead.current?.();
      return items;
    },
  };
});
vi.mock("next/cache", () => ({ revalidatePath: mocks.revalidatePath }));
vi.mock("@/lib/auth/server", () => ({ auth: { api: { requestPasswordReset: mocks.requestPasswordReset } } }));
vi.mock("@/lib/auth/session", () => ({ getRequiredSession: async () => mocks.session.current }));

import { pool } from "@/lib/db/pool";
import { TEST_DATABASE_OWNER_URL } from "@/test/db-env";
import { withUserTransaction } from "@/lib/db/transaction";
import { quoteOrder } from "@/lib/catalog/quote";
import { placeOrder, refreshOrderState } from "@/lib/orders/queries";
import {
  randomCpf,
  seedBureauCost,
  seedCatalogItem,
  setPlatformSale,
  seedClientWalletTopup,
  seedTenant,
  type SeededTenant,
} from "@/test/seed";

import { cancelMyOrderAction, openClientOrderAction } from "./orders-client";
import { inviteHolderToPortal, revokeHolderPortalAccess } from "./portal";

const owner = new Pool({ connectionString: TEST_DATABASE_OWNER_URL });

afterAll(async () => {
  try {
    await owner.end();
  } finally {
    await pool.end();
  }
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requestPasswordReset.mockResolvedValue({ status: true });
});

function actAs(tenant: SeededTenant) {
  mocks.session.current = { ...tenant.bureauAdmin, supportSessionId: null };
}

async function emailOf(userId: string): Promise<string> {
  const { rows } = await owner.query<{ email: string }>("select email from profiles where id = $1", [userId]);
  return rows[0].email;
}

async function addAccount(userId: string) {
  await owner.query(
    "insert into account (id, issuer, account_id, provider_id, user_id, password, updated_at) values ($1, 'local:credential', $2, 'credential', $2, 'hash', now())",
    [randomUUID(), userId],
  );
}

async function profileState(userId: string) {
  const { rows } = await owner.query<{ is_active: boolean }>("select is_active from profiles where id = $1", [userId]);
  return rows[0]?.is_active;
}

async function linkedProfile(holderId: string) {
  const { rows } = await owner.query<{ client_profile_id: string | null }>(
    "select client_profile_id from holders where id = $1",
    [holderId],
  );
  return rows[0].client_profile_id;
}

async function unlinkedHolder(tenant: SeededTenant, email: string): Promise<string> {
  const { rows } = await owner.query<{ id: string }>(
    `insert into holders (bureau_id, type, name, document, created_by, email)
     values ($1, 'PF', 'Titular Novo', $2, $3, $4) returning id`,
    [tenant.bureau.id, randomCpf(), tenant.bureauAdmin.userId, email],
  );
  return rows[0].id;
}

async function auditCount(holderId: string, action: string) {
  const { rows } = await owner.query<{ n: number }>(
    "select count(*)::int as n from audit_logs where action = $1 and record_id = $2",
    [action, holderId],
  );
  return rows[0].n;
}

describe.each([
  ["accepted", true],
  ["never accepted", false],
])("revoke then re-invite (%s invite)", (_name, accepted) => {
  it("reactivates the profile, relinks the holder and sends a fresh link", async () => {
    const tenant = await seedTenant(owner, "portal");
    actAs(tenant);
    const email = await emailOf(tenant.client.userId);
    await owner.query("update holders set email = $2 where id = $1", [tenant.holder.id, email]);
    if (accepted) await addAccount(tenant.client.userId);

    await expect(revokeHolderPortalAccess(tenant.holder.id)).resolves.toEqual({ error: null });
    expect(await profileState(tenant.client.userId)).toBe(false);
    expect(await linkedProfile(tenant.holder.id)).toBeNull();

    await expect(inviteHolderToPortal(tenant.holder.id)).resolves.toEqual({ error: null, id: tenant.client.userId });

    expect(await profileState(tenant.client.userId)).toBe(true);
    expect(await linkedProfile(tenant.holder.id)).toBe(tenant.client.userId);
    expect(await auditCount(tenant.holder.id, "portal.reinvite")).toBe(1);
    expect(mocks.requestPasswordReset).toHaveBeenCalledWith({
      body: { email, redirectTo: "http://localhost:3000/update-password" },
    });
  });
});

describe("inviteHolderToPortal", () => {
  it("lets a retry resend after the e-mail failed, and revalidates anyway", async () => {
    const tenant = await seedTenant(owner, "portal");
    actAs(tenant);
    const holderId = await unlinkedHolder(tenant, `novo-${randomUUID()}@example.test`);
    mocks.requestPasswordReset.mockRejectedValueOnce(new Error("smtp down"));

    const first = await inviteHolderToPortal(holderId);

    expect(first.error).toBe("Acesso criado, mas o link para definir a senha falhou. Tente convidar de novo.");
    expect(mocks.revalidatePath).toHaveBeenCalledWith(`/holders/${holderId}`);
    const profileId = await linkedProfile(holderId);
    expect(profileId).not.toBeNull();

    await expect(inviteHolderToPortal(holderId)).resolves.toEqual({ error: null, id: profileId });
    expect(mocks.requestPasswordReset).toHaveBeenCalledTimes(2);
  });

  it("keeps already_invited once the client has an account", async () => {
    const tenant = await seedTenant(owner, "portal");
    actAs(tenant);
    await addAccount(tenant.client.userId);

    await expect(inviteHolderToPortal(tenant.holder.id)).resolves.toEqual({
      error: "Este Titular já tem acesso ao portal. Revogue antes de reenviar.",
    });
    expect(mocks.requestPasswordReset).not.toHaveBeenCalled();
  });

  it("rejects an e-mail that belongs to a profile of another bureau", async () => {
    const tenant = await seedTenant(owner, "portal");
    const other = await seedTenant(owner, "portal-other");
    actAs(tenant);
    const holderId = await unlinkedHolder(tenant, await emailOf(other.client.userId));

    await expect(inviteHolderToPortal(holderId)).resolves.toEqual({ error: "Este e-mail já pertence a outra conta." });
    expect(await linkedProfile(holderId)).toBeNull();
    expect(await profileState(other.client.userId)).toBe(true);
    expect(mocks.requestPasswordReset).not.toHaveBeenCalled();
  });
});

describe("client orders through the portal actions", () => {
  // O validador do schema confere os dígitos: randomCpf() não serve.
  const withCheckDigits = (base: number[], weights: (n: number) => number) => {
    const digit = (digits: number[]) => {
      const sum = digits.reduce((acc, d, i) => acc + d * weights(digits.length - i), 0);
      return sum % 11 < 2 ? 0 : 11 - (sum % 11);
    };
    const first = [...base, digit(base)];
    return [...first, digit(first)].join("");
  };
  const randomBase = (length: number) => Array.from({ length }, () => Math.floor(Math.random() * 9) + 1);
  const validCpf = () => withCheckDigits(randomBase(9), (n) => n + 1);
  const validCnpj = () => withCheckDigits([...randomBase(8), 0, 0, 0, 1], (n) => (n <= 8 ? n + 1 : n - 7));
  const partner = () => ({ document: validCpf(), name: "Sócio Teste", email: `s${randomUUID()}@example.test` });

  async function readyClientTenant(): Promise<SeededTenant> {
    const t = await seedTenant(owner, "portal orders");
    for (const code of ["dossie_pf", "dossie_empresarial"]) {
      await owner.query("update products set active = true where code = $1", [code]);
      const { rows } = await owner.query<{ id: string }>("select id from products where code = $1", [code]);
      await seedBureauCost(owner, {
        bureauId: t.bureau.id,
        productId: rows[0].id,
        cost: "1.00",
        costPerPartner: code === "dossie_empresarial" ? "1.00" : "0.00",
        setBy: t.bureauAdmin.userId,
      });
      await seedCatalogItem(owner, {
        bureauId: t.bureau.id,
        productId: rows[0].id,
        salePrice: "50.00",
        salePricePerPartner: code === "dossie_empresarial" ? "20.00" : "0.00",
        updatedBy: t.bureauAdmin.userId,
      });
    }
    await seedClientWalletTopup(owner, { clientProfileId: t.client.userId, amount: "300.00", createdBy: t.bureauAdmin.userId });
    await owner.query(
      `insert into legal_acceptances (profile_id, document_id)
       select $1, d.id from legal_documents d where d.kind in ('terms', 'privacy') and d.published_at <= now()
          and d.version = (select max(version) from legal_documents x where x.kind = d.kind and x.published_at <= now())`,
      [t.client.userId],
    );
    mocks.session.current = { ...t.client, supportSessionId: null };
    return t;
  }

  const wallet = async (t: SeededTenant) =>
    (
      await owner.query<{ available: string; reserved: string }>(
        "select available::text, reserved::text from client_wallets where client_profile_id = $1",
        [t.client.userId],
      )
    ).rows[0];

  const currentDeclarationVersion = async () =>
    (await owner.query<{ v: number }>("select legal_current_version('buyer_declaration') as v")).rows[0].v;

  const company = (declarationAccepted: boolean, declarationVersion: number) => ({
    productCode: "dossie_empresarial",
    self: false,
    subject: { name: "Empresa Teste Ltda", document: validCnpj() },
    contactEmail: `r${randomUUID()}@example.test`,
    partners: [partner(), partner()],
    declarationAccepted,
    declarationVersion,
  });

  it("opens an empresarial order with 2 partners and the declaration, then 3 authorizations make it ready", async () => {
    const t = await readyClientTenant();

    const result = await openClientOrderAction(company(true, await currentDeclarationVersion()));

    expect(result.error).toBeNull();
    const id = result.id as string;
    const { rows: order } = await owner.query("select state from dossier_orders where dossier_id = $1", [id]);
    expect(order).toEqual([{ state: "awaiting_authorization" }]);
    expect(await wallet(t)).toEqual({ available: "210.00", reserved: "90.00" });
    const { rows: declaration } = await owner.query(
      "select host(ip) as ip, user_agent from order_declarations where dossier_id = $1",
      [id],
    );
    expect(declaration).toEqual([{ ip: "203.0.113.9", user_agent: "vitest-agent" }]);

    const { rowCount } = await owner.query(
      `update scr_authorizations set status = 'authorized', authorized_at = now(), expires_at = now() + interval '30 days'
        where id in (select scr_authorization_id from consultations where dossier_id = $1) and status = 'pending'`,
      [id],
    );
    expect(rowCount).toBe(3);
    const state = await withUserTransaction({ ...t.operator }, (c) => refreshOrderState(c, id));
    expect(state).toBe("ready");
  });

  it("refuses an empresarial order without the declaration and opens nothing", async () => {
    const t = await readyClientTenant();

    await expect(openClientOrderAction(company(false, await currentDeclarationVersion()))).resolves.toEqual({ error: "Marque a declaração para continuar." });

    const { rows } = await owner.query("select 1 from dossier_orders where bureau_id = $1", [t.bureau.id]);
    expect(rows).toHaveLength(0);
    expect(await wallet(t)).toEqual({ available: "300.00", reserved: "0.00" });
  });

  const BUYER_EMAIL_MESSAGE = "Use um e-mail diferente do seu. O seu e-mail só vale na linha com o seu CPF.";
  const orderCount = async (t: SeededTenant) =>
    (await owner.query("select 1 from dossier_orders where bureau_id = $1", [t.bureau.id])).rowCount;

  it("the buyer enters as a member: own valid CPF and own e-mail as a partner opens the order", async () => {
    const t = await readyClientTenant();
    const buyerCpf = validCpf();
    await owner.query("update holders set document = $2 where client_profile_id = $1", [t.client.userId, buyerCpf]);
    const buyerEmail = await emailOf(t.client.userId);

    const result = await openClientOrderAction({
      ...company(true, await currentDeclarationVersion()),
      partners: [{ document: buyerCpf, name: "Comprador Sócio", email: buyerEmail }, partner()],
    });

    expect(result.error).toBeNull();
    const id = result.id as string;
    const { rows: consultations } = await owner.query("select 1 from consultations where dossier_id = $1", [id]);
    expect(consultations).toHaveLength(3);
    const { rows: auths } = await owner.query<{ email: string; status: string }>(
      `select lower(a.email) as email, a.status from scr_authorizations a
         join consultations c on c.scr_authorization_id = a.id where c.dossier_id = $1`,
      [id],
    );
    expect(auths).toHaveLength(3);
    expect(auths.every((a) => a.status === "pending")).toBe(true);
    expect(auths.map((a) => a.email)).toContain(buyerEmail.toLowerCase());
    const { rows: audit } = await owner.query("select metadata->>'self_member' as self_member from audit_logs where action = 'order.open' and record_id = $1", [id]);
    expect(audit).toEqual([{ self_member: "true" }]);
  });

  it("the buyer e-mail on a CPF that is not the buyer's is refused with the contact_is_buyer message and opens nothing", async () => {
    const t = await readyClientTenant();
    await owner.query("update holders set document = $2 where client_profile_id = $1", [t.client.userId, validCpf()]);
    const buyerEmail = await emailOf(t.client.userId);

    await expect(
      openClientOrderAction({
        ...company(true, await currentDeclarationVersion()),
        partners: [{ document: validCpf(), name: "Outra Pessoa", email: buyerEmail }],
      }),
    ).resolves.toEqual({ error: BUYER_EMAIL_MESSAGE });

    expect(await orderCount(t)).toBe(0);
  });

  it("an account with a PJ holder cannot add itself as a partner with its own e-mail", async () => {
    const t = await readyClientTenant();
    await owner.query("update holders set type = 'PJ', document = $2 where client_profile_id = $1", [t.client.userId, validCnpj()]);
    const buyerEmail = await emailOf(t.client.userId);

    await expect(
      openClientOrderAction({
        ...company(true, await currentDeclarationVersion()),
        partners: [{ document: validCpf(), name: "Comprador Sócio", email: buyerEmail }],
      }),
    ).resolves.toEqual({ error: BUYER_EMAIL_MESSAGE });

    expect(await orderCount(t)).toBe(0);
  });

  it("cancelMyOrderAction gives the reservation back and stays inside the own orders", async () => {
    const t = await readyClientTenant();
    const opened = await openClientOrderAction({ productCode: "dossie_pf", self: true });
    expect(opened.error).toBeNull();
    expect(await wallet(t)).toEqual({ available: "250.00", reserved: "50.00" });

    await expect(cancelMyOrderAction(opened.id)).resolves.toEqual({ error: null, id: opened.id });

    expect(await wallet(t)).toEqual({ available: "300.00", reserved: "0.00" });
    const { rows } = await owner.query("select state, state_reason from dossier_orders where dossier_id = $1", [opened.id]);
    expect(rows).toEqual([{ state: "cancelled", state_reason: "cancelled_by_client" }]);

    const other = await readyClientTenant();
    await expect(cancelMyOrderAction(opened.id)).resolves.toEqual({ error: "Pedido não encontrado." });
    expect(await wallet(other)).toEqual({ available: "300.00", reserved: "0.00" });
  });

  it("a price changed after the quote returns the price_mismatch message and reserves nothing", async () => {
    const t = await readyClientTenant();
    mocks.afterCatalogRead.current = async () => {
      const pf = await owner.query<{ id: string }>("select id from products where code = 'dossie_pf'");
      await setPlatformSale(owner, { bureauId: t.bureau.id, productId: pf.rows[0].id, salePrice: "60.00", cost: "40.00", setBy: t.bureauAdmin.userId });
    };

    try {
      await expect(openClientOrderAction({ productCode: "dossie_pf", self: true })).resolves.toEqual({
        error: "O preço mudou. Revise e confirme de novo.",
      });
    } finally {
      mocks.afterCatalogRead.current = null;
    }

    expect(await wallet(t)).toEqual({ available: "300.00", reserved: "0.00" });
    const { rows } = await owner.query("select 1 from dossier_orders where bureau_id = $1", [t.bureau.id]);
    expect(rows).toHaveLength(0);
  });

  it("an outdated declaration version aborts placeOrder and leaves no order, no reservation", async () => {
    const t = await readyClientTenant();
    const quote = await quoteOrder({ ...t.operator }, "dossie_pf", { partnerCount: 0 });
    if (!quote.ok) throw new Error(quote.reason);

    const result = await placeOrder(
      { ...t.client },
      { productCode: "dossie_pf", self: true, subject: null, partners: [], contact: { email: null, phoneE164: null }, buyerProfileId: null },
      quote,
      { declaration: { version: 999, ip: null, userAgent: null } },
    );

    expect(result).toEqual({ ok: false, reason: "declaration_outdated" });
    expect(await wallet(t)).toEqual({ available: "300.00", reserved: "0.00" });
    const { rows } = await owner.query("select 1 from dossier_orders where bureau_id = $1", [t.bureau.id]);
    expect(rows).toHaveLength(0);
  });
});
