"use client";

import { useEffect, useRef, useState, useTransition } from "react";

import { confirmScrSelfAuthorization } from "@/actions/scr-self";
import { Button } from "@/components/ui/button";
import { KeyRound } from "lucide-react";

import { IconInput } from "@/components/auth/icon-input";
import { Dialog } from "@/components/ui/dialog";
import { Field } from "@/components/ui/field";
import { StatusBanner } from "@/components/ui/status-banner";

type Done = "authorized" | "refused";

export function ScrSelfAuthorizeForm({ token }: { token: string }) {
  const [code, setCode] = useState("");
  const [codeError, setCodeError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<Done | null>(null);
  const [expired, setExpired] = useState<string | null>(null);
  const [confirmingRefuse, setConfirmingRefuse] = useState(false);
  const [isPending, startTransition] = useTransition();
  const codeRef = useRef<HTMLInputElement>(null);

  // Erro do código leva o foco ao campo, para quem usa leitor de tela ou teclado.
  useEffect(() => {
    if (codeError) codeRef.current?.focus();
  }, [codeError]);

  const submit = (decision: "authorize" | "refuse") => {
    setError(null);
    setCodeError(null);
    if (decision === "authorize" && code.trim().length === 0) {
      setCodeError("Informe o código de confirmação.");
      return;
    }
    startTransition(async () => {
      const res = await confirmScrSelfAuthorization(token, code, decision);
      if (res.status === "authorized") setDone("authorized");
      else if (res.status === "refused") setDone("refused");
      else if (res.status === "already") setDone("authorized");
      else if (res.status === "expired") setExpired(res.message);
      else if (res.status === "invalid_code") setCodeError(res.message);
      else setError(res.message);
    });
  };

  const refuse = () => {
    setConfirmingRefuse(false);
    submit("refuse");
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
      <div className="space-y-2 text-sm text-muted-foreground">
        <p>
          <strong className="text-foreground">Autorizar</strong> libera a consulta ao SCR, como descrito no termo acima, e a
          pesquisa segue. É preciso informar o código recebido por e-mail.
        </p>
        <p>
          <strong className="text-foreground">Recusar</strong> encerra este pedido: nenhuma consulta será realizada. Não
          precisa de código. Depois de responder, esta página não aceita outra resposta.
        </p>
      </div>
      <Field id="code" label="Código de confirmação" error={codeError}>
        {(a) => (
          <IconInput
            ref={codeRef}
            icon={KeyRound}
            value={code}
            onChange={(e) => setCode(e.target.value.toUpperCase())}
            placeholder="Código recebido por e-mail"
            autoComplete="off"
            className="font-mono tracking-widest sm:max-w-xs"
            {...a}
          />
        )}
      </Field>
      {error && <StatusBanner tone="attention" title={error} />}
      <div className="flex flex-col gap-3 sm:flex-row">
        <Button glow onClick={() => submit("authorize")} disabled={isPending}>
          {isPending ? "Enviando..." : "Autorizar"}
        </Button>
        <Button variant="outline" onClick={() => setConfirmingRefuse(true)} disabled={isPending}>
          Recusar
        </Button>
      </div>

      <Dialog
        open={confirmingRefuse}
        onClose={() => setConfirmingRefuse(false)}
        title="Recusar a autorização?"
        role="alertdialog"
      >
        <p className="text-sm text-muted-foreground">
          Ao recusar, este pedido é encerrado e nenhuma consulta será realizada. Esta página não aceita outra resposta
          depois disso.
        </p>
        <div className="flex justify-end gap-2">
          <Button autoFocus variant="outline" onClick={() => setConfirmingRefuse(false)}>
            Voltar
          </Button>
          <Button variant="destructive" onClick={refuse}>
            Recusar
          </Button>
        </div>
      </Dialog>
    </div>
  );
}
