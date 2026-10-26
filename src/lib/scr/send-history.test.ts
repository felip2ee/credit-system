import { describe, expect, it } from "vitest";

import { countSent, type ScrSendRecord } from "./send-history";

const rec = (over: Partial<ScrSendRecord>): ScrSendRecord => ({
  id: "1", channel: "email", recipientMasked: "a***@x.com", status: "pending", attempts: 0,
  lastErrorCode: null, createdAt: "2026-10-26T10:00:00Z", sentAt: null, ...over,
});

describe("countSent", () => {
  it("counts only records that reached the provider", () => {
    expect(countSent([
      rec({ status: "delivered", sentAt: "2026-10-26T10:01:00Z" }),
      rec({ status: "suppressed" }),
      rec({ status: "failed", attempts: 3, lastErrorCode: "smtp" }),
      rec({ status: "sent", sentAt: "2026-10-26T11:00:00Z", channel: "whatsapp" }),
    ])).toBe(2);
  });
  it("returns 0 for no records", () => expect(countSent([])).toBe(0));
});
