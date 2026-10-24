"use client";

import { useEffect } from "react";

// Substitui o layout raiz: sem CSS global nem componentes, só HTML e estilo em linha.
export default function GlobalError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    console.error("global error", error.digest ?? "");
  }, [error]);

  return (
    <html lang="pt-BR">
      <body style={{ margin: 0, background: "#FCEDCE", color: "#122C2B", fontFamily: "system-ui, sans-serif", fontSize: 18, lineHeight: 1.5 }}>
        <main style={{ maxWidth: 560, margin: "0 auto", padding: 24 }}>
          <h1 style={{ fontSize: 24 }}>Algo deu errado</h1>
          <p>Não conseguimos abrir o sistema. Tente de novo. Se continuar, fale com o suporte.</p>
          <button
            type="button"
            onClick={reset}
            style={{ minHeight: 48, padding: "0 20px", fontSize: 18, fontWeight: 700, background: "#007A76", color: "#fff", border: 0, borderRadius: 6 }}
          >
            Tentar de novo
          </button>{" "}
          <a href="/" style={{ display: "inline-block", minHeight: 48, lineHeight: "48px", padding: "0 20px", color: "#122C2B", fontWeight: 700 }}>
            Voltar ao início
          </a>
        </main>
      </body>
    </html>
  );
}
