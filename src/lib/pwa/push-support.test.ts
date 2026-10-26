import { describe, expect, it } from "vitest";

import { pushSupport, type BrowserTraits } from "./push-support";

const IPHONE_17_2 =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_2 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2 Mobile/15E148 Safari/604.1";
const IPHONE_16_3 = IPHONE_17_2.replace("17_2", "16_3");
const IPHONE_16_4 = IPHONE_17_2.replace("17_2", "16_4");
const IPHONE_CHROME =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_2 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/120.0.0.0 Mobile/15E148 Safari/604.1";
const IPAD_DESKTOP_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2 Safari/605.1.15";
const ANDROID_CHROME =
  "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36";

function traits(overrides: Partial<BrowserTraits>): BrowserTraits {
  return {
    userAgent: ANDROID_CHROME,
    maxTouchPoints: 5,
    standalone: false,
    hasServiceWorker: true,
    hasPushManager: true,
    hasNotification: true,
    ...overrides,
  };
}

describe("pushSupport", () => {
  it("iPhone iOS 17.2 no Safari pede instalação", () => {
    expect(pushSupport(traits({ userAgent: IPHONE_17_2 }))).toBe("ios_install_required");
  });

  it("iPhone iOS 17.2 instalado fica pronto", () => {
    expect(pushSupport(traits({ userAgent: IPHONE_17_2, standalone: true }))).toBe("ready");
  });

  it("iOS 16.3 instalado é antigo demais", () => {
    expect(pushSupport(traits({ userAgent: IPHONE_16_3, standalone: true }))).toBe("ios_too_old");
  });

  it("iOS 16.4 instalado fica pronto", () => {
    expect(pushSupport(traits({ userAgent: IPHONE_16_4, standalone: true }))).toBe("ready");
  });

  it("iPadOS com UA Macintosh e toque pede instalação", () => {
    expect(pushSupport(traits({ userAgent: IPAD_DESKTOP_UA, maxTouchPoints: 5 }))).toBe("ios_install_required");
  });

  it("Mac Safari sem toque fica pronto", () => {
    expect(pushSupport(traits({ userAgent: IPAD_DESKTOP_UA, maxTouchPoints: 0 }))).toBe("ready");
  });

  it("Android Chrome fica pronto", () => {
    expect(pushSupport(traits({}))).toBe("ready");
  });

  it("Chrome no iPhone pede instalação", () => {
    expect(pushSupport(traits({ userAgent: IPHONE_CHROME }))).toBe("ios_install_required");
  });

  it.each(["hasServiceWorker", "hasPushManager", "hasNotification"] as const)("sem %s não é suportado", (key) => {
    expect(pushSupport(traits({ [key]: false }))).toBe("unsupported");
  });
});
