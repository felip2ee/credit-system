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
  // Cada erro do código incrementa o contador: o alerta é remontado (leitor de tela anuncia de novo) e o foco volta ao campo.
  const [codeErrorTick, setCodeErrorTick] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<Done | null>(null);
  const [expired, setExpired] = useState<string | null>(null);
  const [answered, setAnswered] = useState<string | null>(null);
  const [confirmingRefuse, setConfirmingRefuse] = useState(false);
  const [isPending, startTransition] = useTransition();
  const codeRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (codeErrorTick > 0) codeRef.current?.focus();
  }, [codeErrorTick]);

  const showCodeError = (message: string) => {
    setCodeError(message);
    setCodeErrorTick((tick) => tick + 1);
  };

  const submit = (decision: "authorize" | "refuse") => {
    setError(null);
    setCodeError(null);
    if (decision === "authorize" && code.trim().length === 0) {
      showCodeError("Informe o código de confirmação.");
      return;
    }
    startTransition(async () => {
      const res = await confirmScrSelfAuthorization(token, code, decision);
      if (res.status === "authorized") setDone("authorized");
      else if (res.status === "refused") setDone("refused");
      else if (res.status === "already") setAnswered(res.message);
      else if (res.status === "expired") setExpired(res.message);
      else if (res.status === "invalid_code") showCodeError(res.message);
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
  if (answered) {
    return <StatusBanner tone="neutral" title={answered} />;
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
          <strong className="text-foreground">Recusar</strong> não precisa de código. Nenhuma consulta será realizada com
          esta recusa. Não é possível mudar a resposta depois.
        </p>
      </div>
      <Field key={codeErrorTick} id="code" label="Código de confirmação" error={codeError}>
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
          Nenhuma consulta será realizada com esta recusa. Não é possível mudar a resposta depois.
        </p>
        {/* "Voltar" vem primeiro no DOM: a ordem é o que dá o foco inicial seguro ao abrir o diálogo. */}
        <div className="flex flex-wrap justify-end gap-2">
          <Button variant="outline" onClick={() => setConfirmingRefuse(false)}>
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
