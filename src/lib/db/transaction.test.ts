import type { PoolClient } from "pg";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { connect } = vi.hoisted(() => ({ connect: vi.fn() }));

vi.mock("./pool", () => ({
  pool: { connect },
}));

import { withUserTransaction } from "./transaction";

describe("withUserTransaction", () => {
  beforeEach(() => {
    connect.mockReset();
  });

  it("invalidates a client when rollback fails", async () => {
    const callbackError = new Error("callback failed");
    const rollbackError = new Error("rollback failed");
    const release = vi.fn();
    const client = {
      query: vi.fn(async (query: string) => {
        if (query === "rollback") throw rollbackError;
        return { rows: [] };
      }),
      release,
    } as unknown as PoolClient;

    connect.mockResolvedValue(client);

    await expect(
      withUserTransaction({ userId: "user-1", role: "client" }, async () => {
        throw callbackError;
      }),
    ).rejects.toBe(callbackError);

    expect(release).toHaveBeenCalledWith(rollbackError);
  });
});
