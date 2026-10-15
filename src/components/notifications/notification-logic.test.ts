import { describe, expect, it } from "vitest";

import { NOTIFICATION_BADGE, canRetryNotification } from "./notification-logic";

describe("NOTIFICATION_BADGE", () => {
  it("agrupa estados em rótulos pt-BR", () => {
    expect(NOTIFICATION_BADGE.pending.label).toBe("Na fila");
    expect(NOTIFICATION_BADGE.sending.label).toBe("Na fila");
    expect(NOTIFICATION_BADGE.delivered.label).toBe("Entregue");
    expect(NOTIFICATION_BADGE.read.label).toBe("Entregue");
    expect(NOTIFICATION_BADGE.suppressed.label).toBe("Bloqueado (opt-out)");
  });
});

describe("canRetryNotification", () => {
  it("só falha, só com permissão de gravação e só com payload guardado", () => {
    expect(canRetryNotification("failed", true, true)).toBe(true);
    expect(canRetryNotification("failed", false, true)).toBe(false);
    expect(canRetryNotification("failed", true, false)).toBe(false);
    expect(canRetryNotification("sent", true, true)).toBe(false);
    expect(canRetryNotification("pending", true, true)).toBe(false);
  });
});
