import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  query: vi.fn<(sql: string) => Promise<unknown>>(),
  root: "",
}));

vi.mock("@/lib/db/pool", () => ({
  pool: { query: state.query },
}));

const roots: string[] = [];

function makeRoot() {
  const root = mkdtempSync(path.join(os.tmpdir(), "health-root-"));
  roots.push(root);
  return root;
}

async function loadReady(documentRoot: string) {
  Object.assign(process.env, {
    DATABASE_URL: "postgres://app_runtime:test@localhost:54329/credit_system",
    BETTER_AUTH_SECRET: "0123456789abcdef0123456789abcdef",
    BETTER_AUTH_URL: "http://localhost:3000",
    DOCUMENT_ROOT: documentRoot,
    CLAMAV_HOST: "localhost",
    CLAMAV_PORT: "3310",
    SMTP_HOST: "smtp.example.test",
    SMTP_PORT: "465",
    SMTP_SECURE: "true",
    SMTP_USER: "credit-system",
    SMTP_PASS: "test-password",
  });
  vi.resetModules();
  return import("./ready/route");
}

beforeEach(() => {
  state.query.mockReset();
  state.query.mockResolvedValue({ rows: [{ ok: 1 }] });
});

afterAll(() => {
  roots.forEach((root) => rmSync(root, { recursive: true, force: true }));
});

describe("health endpoints", () => {
  // Catches: adding a DB or filesystem dependency to the liveness probe.
  it("keeps liveness independent of dependencies", async () => {
    const { GET } = await import("./live/route");

    const response = await GET();

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("ok");
    expect(state.query).not.toHaveBeenCalled();
  });

  // Catches: removing the database query from readiness while still returning healthy.
  it("returns ready after a database probe and writable document probe", async () => {
    const root = makeRoot();
    const { GET } = await loadReady(root);

    const response = await GET();

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("ready");
    expect(state.query).toHaveBeenCalledWith("select 1");
    expect(readdirSync(root)).toEqual([]);
  });

  // Catches: treating a failed DB dependency as ready or exposing its error text.
  it("masks database failures with service unavailable", async () => {
    state.query.mockRejectedValueOnce(new Error("postgres://secret@db:5432/nope"));
    const { GET } = await loadReady(makeRoot());

    const response = await GET();
    const body = await response.text();

    expect(response.status).toBe(503);
    expect(body).toBe("unavailable");
    expect(body).not.toContain("secret");
  });

  // Catches: treating a non-writable document root as ready.
  it("returns service unavailable when the document root cannot create a probe", async () => {
    const parent = makeRoot();
    const blocked = path.join(parent, "not-a-directory");
    writeFileSync(blocked, "blocked");
    const { GET } = await loadReady(blocked);

    const response = await GET();

    expect(response.status).toBe(503);
    expect(await response.text()).toBe("unavailable");
  });
});
