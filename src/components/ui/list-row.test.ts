import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Wallet } from "lucide-react";
import { describe, expect, it } from "vitest";

import { ListRow } from "./list-row";

describe("ListRow", () => {
  it("corta título e subtítulo longos em uma linha", () => {
    const long = "A".repeat(60);
    const html = renderToStaticMarkup(createElement(ListRow, { icon: Wallet, title: long, subtitle: long }));

    expect(html).not.toContain("break-words");
    expect(html.match(/class="[^"]*\btruncate\b[^"]*"/g)).toHaveLength(2);
    expect(html).toContain("min-w-0");
  });

  it("com wrap, quebra o texto em vez de cortar e desce o valor no celular", () => {
    const html = renderToStaticMarkup(createElement(ListRow, { icon: Wallet, title: "T", subtitle: "S", value: "R$ 1,00", wrap: true }));

    expect(html).not.toMatch(/class="[^"]*\btruncate\b/);
    expect(html).toContain("break-words");
    expect(html).toContain("max-sm:flex-wrap");
    expect(html).toContain("max-sm:basis-full");
  });
});
