import { describe, expect, it } from "vitest";

import { emailTokenSchema, notificationChannelSchema, phoneCodeSchema } from "./account";

describe("phoneCodeSchema", () => {
  it.each(["12345", "12a456", "123 456", "1234567"])("rejects %j", (code) => {
    expect(phoneCodeSchema.safeParse({ code }).success).toBe(false);
  });

  it("accepts a padded 6-digit code and trims it", () => {
    expect(phoneCodeSchema.parse({ code: " 123456 " })).toEqual({ code: "123456" });
  });
});

describe("notificationChannelSchema", () => {
  it("accepts email and whatsapp only", () => {
    expect(notificationChannelSchema.safeParse({ channel: "whatsapp" }).success).toBe(true);
    expect(notificationChannelSchema.safeParse({ channel: "sms" }).success).toBe(false);
  });
});

describe("emailTokenSchema", () => {
  it("accepts 43 base64url characters", () => {
    expect(emailTokenSchema.safeParse("a".repeat(43)).success).toBe(true);
  });

  it("rejects 42 characters and a + character", () => {
    expect(emailTokenSchema.safeParse("a".repeat(42)).success).toBe(false);
    expect(emailTokenSchema.safeParse(`${"a".repeat(42)}+`).success).toBe(false);
  });
});
