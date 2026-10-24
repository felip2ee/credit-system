"use client";

import { useState, useTransition } from "react";

import { confirmScrSelfAuthorization } from "@/actions/scr-self";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { StatusBanner } from "@/components/ui/status-banner";

type Done = "authorized" | "refused";

export function ScrSelfAuthorizeForm({ token }: { token: string }) {
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<Done | null>(null);
  const [expired, setExpired] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  const submit = (decision: "authorize" | "refuse") => {
    setError(null);
    if (decision === "authorize" && code.trim().length === 0) {
      setError("Informe o código de confirmação.");
      return;
    }
    startTransition(async () => {
      const res = await confirmScrSelfAuthorization(token, code, decision);
      if (res.status === "authorized") setDone("authorized");
      else if (res.status === "refused") setDone("refused");
      else if (res.status === "already") setDone("authorized");
      else if (res.status === "expired") setExpired(res.message);
      else setError(res.message);
    });
  };

  if (done === "authorized") {
    return <StatusBanner tone="success" title="Autorização concedida com sucesso." description="Você já pode fechar esta página." />;
  }
  if (expired) {
    return <StatusBanner tone="attention" title={expired} />;
  }
  if (done === "refused") {
    return <StatusBanner tone="neutral" title="Autorização recusada." description="Nenhuma consulta será realizada." />;
  }

  return (
    <div className="space-y-4">
      <div className="space-y-2">
        <Label htmlFor="code">Código de confirmação</Label>
        <Input
          id="code"
          value={code}
          onChange={(e) => setCode(e.target.value.toUpperCase())}
          placeholder="Código recebido por e-mail"
          autoComplete="off"
          className="font-mono tracking-widest sm:max-w-xs"
        />
      </div>
      {error && <StatusBanner tone="attention" title={error} />}
      <div className="flex flex-col gap-3 sm:flex-row">
        <Button size="lg" onClick={() => submit("authorize")} disabled={isPending}>
          {isPending ? "Enviando..." : "Autorizar"}
        </Button>
        <Button size="lg" variant="outline" onClick={() => submit("refuse")} disabled={isPending}>
          Recusar
        </Button>
      </div>
    </div>
  );
}
