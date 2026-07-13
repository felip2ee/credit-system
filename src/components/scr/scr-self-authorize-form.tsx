"use client";

import { useState, useTransition } from "react";

import { confirmScrSelfAuthorization } from "@/actions/scr-self";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

type Done = "authorized" | "refused";

export function ScrSelfAuthorizeForm({ token }: { token: string }) {
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<Done | null>(null);
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
      else setError(res.message);
    });
  };

  if (done === "authorized") {
    return (
      <div className="rounded-md border border-emerald-200 bg-emerald-50 p-4 text-sm text-emerald-800">
        Autorização concedida com sucesso. Você já pode fechar esta página.
      </div>
    );
  }
  if (done === "refused") {
    return (
      <div className="rounded-md border bg-muted p-4 text-sm text-muted-foreground">
        Autorização recusada. Nenhuma consulta será realizada.
      </div>
    );
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
          className="max-w-xs font-mono tracking-widest"
        />
        {error && <p className="text-sm text-destructive">{error}</p>}
      </div>
      <div className="flex gap-2">
        <Button
          onClick={() => submit("authorize")}
          disabled={isPending}
          className="bg-[#0E8C84] text-white hover:bg-[#0B5F59]"
        >
          {isPending ? "Enviando..." : "Autorizar"}
        </Button>
        <Button
          variant="outline"
          onClick={() => submit("refuse")}
          disabled={isPending}
        >
          Recusar
        </Button>
      </div>
    </div>
  );
}
