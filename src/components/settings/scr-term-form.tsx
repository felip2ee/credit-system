"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";

import { saveScrTermSettings, type ScrTermSettings } from "@/actions/settings";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { StatusBanner } from "@/components/ui/status-banner";

// A action devolve uma frase só para o termo: o erro vai para o primeiro campo obrigatório vazio, ou para o formulário.
const REQUIRED_FIELDS = ["authorizedName", "institutionName", "city"] as const;

export function ScrTermForm({ initial }: { initial: ScrTermSettings }) {
  const router = useRouter();
  const [values, setValues] = useState<ScrTermSettings>(initial);
  const [isPending, startTransition] = useTransition();
  const [msg, setMsg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const set = (k: keyof ScrTermSettings) => (e: React.ChangeEvent<HTMLInputElement>) => {
    setError(null);
    setValues((v) => ({ ...v, [k]: e.target.value }));
  };

  const onSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setMsg(null);
    setError(null);
    startTransition(async () => {
      const res = await saveScrTermSettings(values);
      if (res.error) setError(res.error);
      else {
        setMsg("Termo atualizado.");
        router.refresh();
      }
    });
  };

  const emptyField = error ? REQUIRED_FIELDS.find((k) => values[k].trim() === "") : undefined;
  const fieldError = (k: keyof ScrTermSettings) => (emptyField === k ? error : null);

  return (
    <Card>
      <CardHeader>
        <CardTitle>Termo de consentimento SCR</CardTitle>
        <CardDescription>
          Estes valores entram no termo enviado ao titular na autogestão de SCR e valem para todos os Bureaus.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={onSubmit} className="space-y-4" noValidate>
          <Field
            id="authorizedName"
            label="Autorizado a consultar"
            helper="Quem o titular autoriza a consultar o SCR (ex.: o escritório/consultor). Obrigatório."
            error={fieldError("authorizedName")}
          >
            {(a11y) => <Input {...a11y} value={values.authorizedName} onChange={set("authorizedName")} />}
          </Field>
          <Field
            id="authorizedDocument"
            label="CNPJ de quem opera"
            helper="Opcional. Quando preenchido, entra no termo junto ao nome."
          >
            {(a11y) => (
              <Input
                {...a11y}
                value={values.authorizedDocument}
                onChange={set("authorizedDocument")}
                placeholder="00.000.000/0000-00"
              />
            )}
          </Field>
          <Field id="institutionName" label="Instituição" helper="Obrigatório." error={fieldError("institutionName")}>
            {(a11y) => <Input {...a11y} value={values.institutionName} onChange={set("institutionName")} />}
          </Field>
          <Field id="city" label="Cidade / UF" helper="Obrigatório." error={fieldError("city")}>
            {(a11y) => <Input {...a11y} value={values.city} onChange={set("city")} />}
          </Field>

          {error && !emptyField && <StatusBanner tone="danger" title={error} />}
          {msg && <StatusBanner tone="success" title={msg} />}

          <Button type="submit" disabled={isPending}>
            {isPending ? "Salvando..." : "Salvar"}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}
