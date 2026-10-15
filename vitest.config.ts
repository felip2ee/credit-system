import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  // tsconfig usa jsx:"preserve" (Next); o Vitest precisa transformar JSX para renderizar componentes.
  oxc: { jsx: { runtime: "automatic" } },
  resolve: {
    // Resolve o alias "@/..." igual ao tsconfig (paths) nos testes.
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
