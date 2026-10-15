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
  it("só falha, e só com permissão de gravação", () => {
    expect(canRetryNotification("failed", true)).toBe(true);
    expect(canRetryNotification("failed", false)).toBe(false);
    expect(canRetryNotification("sent", true)).toBe(false);
  });
});
