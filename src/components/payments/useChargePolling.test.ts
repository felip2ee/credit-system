import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/actions/checkout-context", () => ({ getChargeStatusAction: vi.fn() }));

import { pollChargeStatus } from "./useChargePolling";

const ID = "22222222-2222-4222-8222-222222222222";

describe("pollChargeStatus", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("devolve paid na primeira consulta que sair de pending, a cada 3 s", async () => {
    const fetchStatus = vi
      .fn()
      .mockResolvedValueOnce({ error: null, status: "pending" })
      .mockResolvedValueOnce({ error: null, status: "paid" });
    const p = pollChargeStatus(ID, fetchStatus, new AbortController().signal);
    await vi.advanceTimersByTimeAsync(2999);
    expect(fetchStatus).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(fetchStatus).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(3000);
    await expect(p).resolves.toBe("paid");
    expect(fetchStatus).toHaveBeenCalledTimes(2);
  });

  it("desiste em 60 s com timeout, 20 consultas, mesmo com erro de consulta", async () => {
    const fetchStatus = vi
      .fn()
      .mockResolvedValueOnce({ error: "falha" })
      .mockRejectedValueOnce(new Error("rede"))
      .mockResolvedValue({ error: null, status: "pending" });
    const p = pollChargeStatus(ID, fetchStatus, new AbortController().signal);
    await vi.advanceTimersByTimeAsync(60000);
    await expect(p).resolves.toBe("timeout");
    expect(fetchStatus).toHaveBeenCalledTimes(20);
  });

  it("aborta sem consultar de novo", async () => {
    const ctl = new AbortController();
    const fetchStatus = vi.fn();
    const p = pollChargeStatus(ID, fetchStatus, ctl.signal);
    ctl.abort();
    await vi.advanceTimersByTimeAsync(10000);
    await expect(p).resolves.toBe("aborted");
    expect(fetchStatus).not.toHaveBeenCalled();
  });

  it("devolve cancelled", async () => {
    const fetchStatus = vi.fn().mockResolvedValue({ error: null, status: "cancelled" });
    const p = pollChargeStatus(ID, fetchStatus, new AbortController().signal);
    await vi.advanceTimersByTimeAsync(3000);
    await expect(p).resolves.toBe("cancelled");
  });
});
