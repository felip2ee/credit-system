"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";

import { saveScrTermSettings, type ScrTermSettings } from "@/actions/settings";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

export function ScrTermForm({ initial }: { initial: ScrTermSettings }) {
  const router = useRouter();
  const [values, setValues] = useState<ScrTermSettings>(initial);
  const [isPending, startTransition] = useTransition();
  const [msg, setMsg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const set = (k: keyof ScrTermSettings) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setValues((v) => ({ ...v, [k]: e.target.value }));

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

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-lg">Termo de consentimento SCR</CardTitle>
        <CardDescription>
          Estes valores entram no termo enviado ao titular na autogestão de SCR.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={onSubmit} className="space-y-5">
          <div className="space-y-2">
            <Label htmlFor="authorizedName">Autorizado a consultar</Label>
            <Input
              id="authorizedName"
              value={values.authorizedName}
              onChange={set("authorizedName")}
            />
            <p className="text-xs text-muted-foreground">
              Quem o titular autoriza a consultar o SCR (ex.: o escritório/consultor).
            </p>
          </div>
          <div className="space-y-2">
            <Label htmlFor="authorizedDocument">CNPJ de quem opera</Label>
            <Input
              id="authorizedDocument"
              value={values.authorizedDocument}
              onChange={set("authorizedDocument")}
              placeholder="00.000.000/0000-00"
            />
            <p className="text-xs text-muted-foreground">
              Opcional — quando preenchido, entra no termo junto ao nome.
            </p>
          </div>
          <div className="space-y-2">
            <Label htmlFor="institutionName">Instituição</Label>
            <Input
              id="institutionName"
              value={values.institutionName}
              onChange={set("institutionName")}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="city">Cidade / UF</Label>
            <Input id="city" value={values.city} onChange={set("city")} />
          </div>

          {error && <p className="text-sm text-destructive">{error}</p>}
          {msg && <p className="text-sm text-emerald-600">{msg}</p>}

          <Button type="submit" disabled={isPending}>
            {isPending ? "Salvando..." : "Salvar"}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}
