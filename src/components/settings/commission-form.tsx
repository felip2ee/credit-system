"use client";

import { useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";

import { saveCommissionRate } from "@/actions/settings";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

const schema = z.object({
  rate: z.coerce
    .number({ invalid_type_error: "Informe um número." })
    .min(0, "Mínimo 0%.")
    .max(100, "Máximo 100%."),
});

type FormValues = z.infer<typeof schema>;

export function CommissionForm({ initialRate }: { initialRate: number }) {
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: { rate: initialRate },
  });

  const onSubmit = async (values: FormValues) => {
    setError(null);
    setSaved(false);
    const res = await saveCommissionRate(values.rate);
    if (res.error) {
      setError(res.error);
      return;
    }
    setSaved(true);
  };

  return (
    <Card className="max-w-md">
      <CardHeader>
        <CardTitle className="text-lg">Comissão padrão estimada</CardTitle>
        <CardDescription>
          Percentual sobre o valor aprovado usado para estimar a comissão bruta
          no Dashboard, quando a oportunidade não tem taxa própria.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="rate">Comissão (%)</Label>
            <div className="flex items-center gap-2">
              <Input
                id="rate"
                type="number"
                step="0.1"
                min={0}
                max={100}
                className="w-32"
                {...register("rate")}
              />
              <span className="text-sm text-muted-foreground">% do aprovado</span>
            </div>
            {errors.rate && (
              <p className="text-sm text-destructive">{errors.rate.message}</p>
            )}
          </div>
          {error && <p className="text-sm text-destructive">{error}</p>}
          {saved && (
            <p className="text-sm text-emerald-600">Comissão atualizada.</p>
          )}
          <Button type="submit" disabled={isSubmitting}>
            {isSubmitting ? "Salvando..." : "Salvar"}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}
