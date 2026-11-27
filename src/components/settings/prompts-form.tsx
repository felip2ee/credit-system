"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { RotateCcw, Save } from "lucide-react";

import { saveAiPrompts, type AiPromptEntry } from "@/actions/settings";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Dialog } from "@/components/ui/dialog";
import type { AiPromptKind } from "@/lib/ai/prompt";
import { StatusBanner } from "@/components/ui/status-banner";
import { Textarea } from "@/components/ui/textarea";

export function PromptsForm({ prompts }: { prompts: AiPromptEntry[] }) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [confirming, setConfirming] = useState(false);
  const [values, setValues] = useState<Record<AiPromptKind, string>>(
    () =>
      Object.fromEntries(prompts.map((p) => [p.kind, p.value])) as Record<
        AiPromptKind,
        string
      >
  );
  const defaults = Object.fromEntries(
    prompts.map((p) => [p.kind, p.defaultValue])
  ) as Record<AiPromptKind, string>;
  const [msg, setMsg] = useState<{ type: "ok" | "err"; text: string } | null>(null);

  const set = (k: AiPromptKind, v: string) =>
    setValues((prev) => ({ ...prev, [k]: v }));

  const onSave = () => {
    setMsg(null);
    startTransition(async () => {
      const res = await saveAiPrompts({
        pf: values.pf,
        pj: values.pj,
        empresa: values.empresa,
      });
      setConfirming(false);
      if (res.error) {
        setMsg({ type: "err", text: res.error });
        return;
      }
      setMsg({ type: "ok", text: "Prompts salvos." });
      router.refresh();
    });
  };

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">
        Os prompts valem para todos os Bureaus e definem como a IA escreve os pareceres. Mantenha o formato de
        saída JSON descrito no texto — alterá-lo pode quebrar a geração. Deixar o
        texto igual ao padrão (ou vazio) remove a personalização e volta a seguir
        o padrão do sistema.
      </p>

      {prompts.map((p) => {
        const val = values[p.kind];
        const isCustom =
          val.trim().length > 0 && val.trim() !== defaults[p.kind].trim();
        const titleId = `prompt-${p.kind}-title`;
        const countId = `prompt-${p.kind}-count`;
        return (
          <Card key={p.kind}>
            <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-2">
              <CardTitle id={titleId}>{p.label}</CardTitle>
              <div className="flex flex-wrap items-center gap-2">
                <Badge variant={isCustom ? "secondary" : "muted"}>
                  {isCustom ? "Personalizado" : "Padrão"}
                </Badge>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => set(p.kind, defaults[p.kind])}
                  disabled={isPending || val === defaults[p.kind]}
                  aria-label={`Restaurar padrão: ${p.label}`}
                >
                  <RotateCcw className="h-4 w-4" />
                  Restaurar padrão
                </Button>
              </div>
            </CardHeader>
            <CardContent className="space-y-1">
              <Textarea
                aria-labelledby={titleId}
                aria-describedby={countId}
                value={val}
                onChange={(e) => set(p.kind, e.target.value)}
                rows={16}
                spellCheck={false}
                className="resize-y font-mono text-sm"
              />
              <p id={countId} className="text-sm text-muted-foreground">
                {val.length.toLocaleString("pt-BR")} caracteres
              </p>
            </CardContent>
          </Card>
        );
      })}

      <div className="space-y-3">
        <p className="text-sm text-muted-foreground">
          Salvar grava os 3 prompts de uma vez e vale para os próximos pareceres de todos os Bureaus.
        </p>
        <Button type="button" onClick={() => setConfirming(true)} disabled={isPending}>
          <Save className="h-4 w-4" />
          Salvar prompts
        </Button>
        {msg && (
          <StatusBanner tone={msg.type === "ok" ? "success" : "danger"} title={msg.text} />
        )}
      </div>

      <Dialog
        open={confirming}
        onClose={() => setConfirming(false)}
        title="Salvar os prompts?"
        role="alertdialog"
        dismissible={!isPending}
      >
        <p className="text-sm text-muted-foreground">
          Os 3 prompts (PF, PJ e Empresa) passam a valer para todos os Bureaus nos próximos pareceres da IA.
        </p>
        <div className="flex flex-wrap justify-end gap-2">
          <Button type="button" variant="outline" autoFocus onClick={() => setConfirming(false)} disabled={isPending}>
            Voltar
          </Button>
          <Button type="button" onClick={onSave} disabled={isPending}>
            {isPending ? "Salvando..." : "Salvar prompts"}
          </Button>
        </div>
      </Dialog>
    </div>
  );
}
