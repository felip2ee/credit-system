import type { PoolClient } from "pg";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { connect } = vi.hoisted(() => ({ connect: vi.fn() }));

vi.mock("./pool", () => ({
  pool: { connect },
}));

import { withUserTransaction } from "./transaction";

function fakeClient(query = vi.fn(async (_sql: string, _params?: string[]) => ({ rows: [] }))) {
  const release = vi.fn();
  const client = { query, release } as unknown as PoolClient;
  connect.mockResolvedValue(client);
  return { query, release };
}

const BUREAU = "22222222-2222-4222-8222-222222222222";
const SUPPORT = "33333333-3333-4333-8333-333333333333";

describe("withUserTransaction", () => {
  beforeEach(() => {
    connect.mockReset();
  });

  it("sets the four context settings in order, then commits", async () => {
    const { query } = fakeClient();

    await withUserTransaction(
      { userId: "user-1", role: "superadmin", bureauId: BUREAU, supportSessionId: SUPPORT },
      async () => undefined,
    );

    expect(query.mock.calls).toEqual([
      ["begin"],
      ["select set_config('app.user_id', $1, true)", ["user-1"]],
      ["select set_config('app.user_role', $1, true)", ["superadmin"]],
      ["select set_config('app.bureau_id', $1, true)", [BUREAU]],
      ["select set_config('app.support_session_id', $1, true)", [SUPPORT]],
      ["commit"],
    ]);
  });

  it("sends an empty string for a null bureau and an absent support session", async () => {
    const { query } = fakeClient();

    await withUserTransaction({ userId: "user-1", role: "superadmin", bureauId: null }, async () => undefined);

    const values = query.mock.calls.slice(1, 5).map(([, params]) => params?.[0]);
    expect(values).toEqual(["user-1", "superadmin", "", ""]);
  });

  it("rolls back and rethrows when the work fails", async () => {
    const { query, release } = fakeClient();
    const failure = new Error("work failed");

    await expect(
      withUserTransaction({ userId: "u", role: "operator", bureauId: BUREAU }, async () => {
        throw failure;
      }),
    ).rejects.toBe(failure);

    expect(query).toHaveBeenLastCalledWith("rollback");
    expect(query).not.toHaveBeenCalledWith("commit");
    expect(release).toHaveBeenCalledWith(undefined);
  });

  it("invalidates a client when rollback fails", async () => {
    const callbackError = new Error("callback failed");
    const rollbackError = new Error("rollback failed");
    const { release } = fakeClient(
      vi.fn(async (query: string) => {
        if (query === "rollback") throw rollbackError;
        return { rows: [] };
      }),
    );

    await expect(
      withUserTransaction({ userId: "user-1", role: "client", bureauId: BUREAU }, async () => {
        throw callbackError;
      }),
    ).rejects.toBe(callbackError);

    expect(release).toHaveBeenCalledWith(rollbackError);
  });
});
