import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const CFG = { baseUrl: "https://deps.test", email: "a@b.test", senha: "x", centroCusto: "" };

const loginBody = [
  {
    access_token: "tok",
    expires_in: 3600,
    produtos: [
      { identificador: "id-pf", nome: "Smart PF 002", tipoPessoa: "F" },
      { identificador: "id-pj", nome: "Smart PJ 010", tipoPessoa: "J" },
    ],
  },
];

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.resetModules();
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  fetchMock = vi.fn(async (url: string) =>
    url.endsWith("/conta/entrar") ? json(loginBody) : json({ ok: true }),
  );
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function client() {
  const { createRealDepsClient } = await import("./real");
  return createRealDepsClient(CFG);
}

const consultBody = () => JSON.parse(fetchMock.mock.calls.at(-1)![1].body as string) as Record<string, unknown>;

describe("real deps client", () => {
  it("real client resolves the product id by options.product", async () => {
    const deps = await client();

    const pf = await deps.consultPF("390.533.447-05", { product: "Smart PF 002" });
    expect(consultBody().identificadorProduto).toBe("id-pf");
    expect(pf.product).toBe("Smart PF 002");

    const pj = await deps.consultPJ("11.222.333/0001-81", { product: "Smart PJ 010" });
    expect(consultBody().identificadorProduto).toBe("id-pj");
    expect(pj.product).toBe("Smart PJ 010");
  });

  it("looks up by the requested name, not by the document type", async () => {
    const deps = await client();

    await deps.consultPF("39053344705", { product: "Smart PJ 010" });

    expect(consultBody().identificadorProduto).toBe("id-pj");
  });

  it("throws with the product name when the account does not have it", async () => {
    const deps = await client();

    await expect(deps.consultPF("39053344705", { product: "Smart PF 999" })).rejects.toThrow(
      'Produto "Smart PF 999" não está disponível para esta conta na deps.',
    );
  });
});
