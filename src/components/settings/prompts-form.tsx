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
import type { AiPromptKind } from "@/lib/ai/prompt";
import { StatusBanner } from "@/components/ui/status-banner";
import { Textarea } from "@/components/ui/textarea";

export function PromptsForm({ prompts }: { prompts: AiPromptEntry[] }) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
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
      if (res.error) {
        setMsg({ type: "err", text: res.error });
        return;
      }
      setMsg({ type: "ok", text: "Prompts salvos." });
      router.refresh();
    });
  };

  return (
    <div className="space-y-6">
      {prompts.map((p) => {
        const val = values[p.kind];
        const isCustom =
          val.trim().length > 0 && val.trim() !== defaults[p.kind].trim();
        return (
          <Card key={p.kind}>
            <CardHeader className="flex flex-row items-center justify-between gap-2">
              <CardTitle className="text-base">{p.label}</CardTitle>
              <div className="flex items-center gap-2">
                <Badge variant={isCustom ? "secondary" : "muted"}>
                  {isCustom ? "Personalizado" : "Padrão"}
                </Badge>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => set(p.kind, defaults[p.kind])}
                  disabled={isPending || val === defaults[p.kind]}
                >
                  <RotateCcw className="h-4 w-4" />
                  Restaurar padrão
                </Button>
              </div>
            </CardHeader>
            <CardContent className="space-y-1">
              <Textarea
                value={val}
                onChange={(e) => set(p.kind, e.target.value)}
                rows={16}
                spellCheck={false}
                className="resize-y font-mono text-sm"
              />
              <p className="text-sm text-muted-foreground">
                {val.length.toLocaleString("pt-BR")} caracteres
              </p>
            </CardContent>
          </Card>
        );
      })}

      <div className="flex items-center gap-3">
        <Button onClick={onSave} disabled={isPending}>
          <Save className="h-4 w-4" />
          {isPending ? "Salvando..." : "Salvar prompts"}
        </Button>
        {msg && (
          <StatusBanner tone={msg.type === "ok" ? "success" : "danger"} title={msg.text} />
        )}
      </div>

      <p className="text-sm text-muted-foreground">
        Os prompts valem para todos os Bureaus e definem como a IA escreve os pareceres. Mantenha o formato de
        saída JSON descrito no texto — alterá-lo pode quebrar a geração. Deixar o
        texto igual ao padrão (ou vazio) remove a personalização e volta a seguir
        o padrão do sistema.
      </p>
    </div>
  );
}
