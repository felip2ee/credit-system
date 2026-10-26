import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

import { ensureOrder, newPage, SCREENS, type Ids } from "./critical-screens";
import { TICK_POLL_TIMEOUT_MS } from "./fixtures";

// Clean context per screen: each one loads its own saved session (see critical-screens.ts).
test.use({ storageState: { cookies: [], origins: [] } });

// Rules the acceptance criteria name; the run is WCAG 2.1 AA (A + AA tags).
const BLOCKING = ["color-contrast", "label", "button-name", "link-name"];

let ids: Ids;
test.beforeAll(async ({ browser }) => {
  test.setTimeout(TICK_POLL_TIMEOUT_MS * 2);
  ids = await ensureOrder(browser);
});

for (const screen of SCREENS) {
  test(`a11y WCAG 2.1 AA: ${screen.name}`, async ({ browser }, testInfo) => {
    const { context, page } = await newPage(browser, screen.auth);
    try {
      await screen.open(page, ids);
      const { violations } = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
      const summary = violations.map((v) => ({ id: v.id, impact: v.impact, nodes: v.nodes.map((n) => n.target.join(" ")) }));
      await testInfo.attach("axe-violations.json", { body: JSON.stringify(summary, null, 2), contentType: "application/json" });
      const blocking = summary.filter((v) => BLOCKING.includes(v.id));
      expect(blocking, JSON.stringify(blocking, null, 2)).toEqual([]);
      // Any other WCAG A/AA violation is reported in the attachment but does not fail this spec.
    } finally {
      await context.close();
    }
  });
}
