"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { Pencil } from "lucide-react";

import { updateRealEstateOrder } from "@/actions/opportunities";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  MARITAL_STATUSES,
  OCCUPATIONS,
  PREFERRED_BANKS,
  PROPERTY_TYPES,
  YES_NO,
  type RealEstateOrder,
} from "@/lib/orders/real-estate-order";

const schema = z.object({
  rg: z.string().trim(),
  profession: z.string().trim(),
  monthly_income: z.string().trim(),
  occupation: z.string().trim(),
  employer: z.string().trim(),
  marital_status: z.string().trim(),
  compose_income: z.string().trim(),
  spouse_name: z.string().trim(),
  spouse_cpf: z.string().trim(),
  spouse_birth_date: z.string().trim(),
  preferred_bank: z.string().trim(),
  property_type: z.string().trim(),
  property_value: z.string().trim(),
  desired_value: z.string().trim(),
  down_payment: z.string().trim(),
  term_months: z.string().trim(),
  use_fgts: z.string().trim(),
  finance_itbi: z.string().trim(),
  has_iq: z.string().trim(),
  property_location: z.string().trim(),
  additional_info: z.string().trim(),
  objective: z.string().trim(),
});

type Values = z.infer<typeof schema>;

const SELECT_CLASS =
  "flex h-10 w-full rounded-md border border-input bg-background px-3 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2";

function ReadField({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="text-sm">{value || "—"}</dd>
    </div>
  );
}

export function RealEstateOrderForm({
  opportunityId,
  initial,
}: {
  opportunityId: string;
  initial: RealEstateOrder;
}) {
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const { register, handleSubmit, reset } = useForm<Values>({
    resolver: zodResolver(schema),
    defaultValues: initial,
  });

  const onSubmit = (values: Values) => {
    setError(null);
    startTransition(async () => {
      const res = await updateRealEstateOrder(opportunityId, values);
      if (res.error) {
        setError(res.error);
        return;
      }
      setEditing(false);
      router.refresh();
    });
  };

  // ── Leitura ──
  if (!editing) {
    return (
      <div className="space-y-5">
        <div className="flex justify-end">
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              reset(initial);
              setEditing(true);
            }}
          >
            <Pencil className="h-4 w-4" />
            Editar
          </Button>
        </div>

        <div>
          <p className="mb-2 text-sm font-medium">Proponente</p>
          <dl className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <ReadField label="RG" value={initial.rg} />
            <ReadField label="Profissão" value={initial.profession} />
            <ReadField label="Renda mensal" value={initial.monthly_income} />
            <ReadField label="Ocupação" value={initial.occupation} />
            <ReadField label="Empresa onde trabalha" value={initial.employer} />
            <ReadField label="Estado civil" value={initial.marital_status} />
            <ReadField label="Vai compor renda?" value={initial.compose_income} />
          </dl>
        </div>

        <div>
          <p className="mb-2 text-sm font-medium">Cônjuge / 2º proponente</p>
          <dl className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <ReadField label="Nome" value={initial.spouse_name} />
            <ReadField label="CPF" value={initial.spouse_cpf} />
            <ReadField label="Data de nascimento" value={initial.spouse_birth_date} />
          </dl>
        </div>

        <div>
          <p className="mb-2 text-sm font-medium">Imóvel e financiamento</p>
          <dl className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <ReadField label="Banco de preferência" value={initial.preferred_bank} />
            <ReadField label="Tipo de imóvel" value={initial.property_type} />
            <ReadField label="Valor do imóvel" value={initial.property_value} />
            <ReadField label="Valor desejado" value={initial.desired_value} />
            <ReadField label="Valor de entrada" value={initial.down_payment} />
            <ReadField label="Prazo (meses)" value={initial.term_months} />
            <ReadField label="Pretende usar FGTS?" value={initial.use_fgts} />
            <ReadField label="Financiar ITBI/cartório?" value={initial.finance_itbi} />
            <ReadField label="Possui IQ (imóvel financiado)?" value={initial.has_iq} />
            <ReadField label="CEP e nº do imóvel" value={initial.property_location} />
            <ReadField label="O que deseja fazer" value={initial.objective} />
            <ReadField label="Informações adicionais" value={initial.additional_info} />
          </dl>
        </div>
      </div>
    );
  }

  // ── Edição ──
  return (
    <form onSubmit={handleSubmit(onSubmit)} className="space-y-5">
      <fieldset className="space-y-4 rounded-md border p-4">
        <legend className="px-1 text-sm font-medium">Proponente</legend>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div className="space-y-2">
            <Label htmlFor="rg">RG</Label>
            <Input id="rg" {...register("rg")} />
          </div>
          <div className="space-y-2">
            <Label htmlFor="profession">Profissão</Label>
            <Input id="profession" {...register("profession")} />
          </div>
          <div className="space-y-2">
            <Label htmlFor="monthly_income">Renda mensal (R$)</Label>
            <Input id="monthly_income" placeholder="0,00" {...register("monthly_income")} />
          </div>
          <div className="space-y-2">
            <Label htmlFor="occupation">Ocupação</Label>
            <select id="occupation" className={SELECT_CLASS} {...register("occupation")}>
              <option value="">— selecione —</option>
              {OCCUPATIONS.map((o) => (
                <option key={o} value={o}>
                  {o}
                </option>
              ))}
            </select>
          </div>
          <div className="space-y-2">
            <Label htmlFor="employer">Empresa onde trabalha</Label>
            <Input id="employer" {...register("employer")} />
          </div>
          <div className="space-y-2">
            <Label htmlFor="marital_status">Estado civil</Label>
            <select id="marital_status" className={SELECT_CLASS} {...register("marital_status")}>
              <option value="">— selecione —</option>
              {MARITAL_STATUSES.map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </select>
          </div>
          <div className="space-y-2">
            <Label htmlFor="compose_income">Vai compor renda?</Label>
            <select id="compose_income" className={SELECT_CLASS} {...register("compose_income")}>
              <option value="">— selecione —</option>
              {YES_NO.map((y) => (
                <option key={y} value={y}>
                  {y}
                </option>
              ))}
            </select>
          </div>
        </div>
      </fieldset>

      <fieldset className="space-y-4 rounded-md border p-4">
        <legend className="px-1 text-sm font-medium">
          Cônjuge / 2º proponente
        </legend>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div className="space-y-2">
            <Label htmlFor="spouse_name">Nome</Label>
            <Input id="spouse_name" {...register("spouse_name")} />
          </div>
          <div className="space-y-2">
            <Label htmlFor="spouse_cpf">CPF</Label>
            <Input id="spouse_cpf" {...register("spouse_cpf")} />
          </div>
          <div className="space-y-2">
            <Label htmlFor="spouse_birth_date">Data de nascimento</Label>
            <Input id="spouse_birth_date" type="date" {...register("spouse_birth_date")} />
          </div>
        </div>
      </fieldset>

      <fieldset className="space-y-4 rounded-md border p-4">
        <legend className="px-1 text-sm font-medium">Imóvel e financiamento</legend>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div className="space-y-2">
            <Label htmlFor="preferred_bank">Banco de preferência</Label>
            <select id="preferred_bank" className={SELECT_CLASS} {...register("preferred_bank")}>
              <option value="">— selecione —</option>
              {PREFERRED_BANKS.map((b) => (
                <option key={b} value={b}>
                  {b}
                </option>
              ))}
            </select>
          </div>
          <div className="space-y-2">
            <Label htmlFor="property_type">Tipo de imóvel</Label>
            <select id="property_type" className={SELECT_CLASS} {...register("property_type")}>
              <option value="">— selecione —</option>
              {PROPERTY_TYPES.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </select>
          </div>
          <div className="space-y-2">
            <Label htmlFor="property_value">Valor do imóvel (R$)</Label>
            <Input id="property_value" placeholder="0,00" {...register("property_value")} />
          </div>
          <div className="space-y-2">
            <Label htmlFor="desired_value">Valor desejado (R$)</Label>
            <Input id="desired_value" placeholder="0,00" {...register("desired_value")} />
          </div>
          <div className="space-y-2">
            <Label htmlFor="down_payment">Valor de entrada (R$)</Label>
            <Input id="down_payment" placeholder="0,00" {...register("down_payment")} />
          </div>
          <div className="space-y-2">
            <Label htmlFor="term_months">Prazo (meses)</Label>
            <Input id="term_months" placeholder="Ex.: 360" {...register("term_months")} />
          </div>
          <div className="space-y-2">
            <Label htmlFor="use_fgts">Pretende usar FGTS?</Label>
            <select id="use_fgts" className={SELECT_CLASS} {...register("use_fgts")}>
              <option value="">— selecione —</option>
              {YES_NO.map((y) => (
                <option key={y} value={y}>
                  {y}
                </option>
              ))}
            </select>
          </div>
          <div className="space-y-2">
            <Label htmlFor="finance_itbi">Financiar ITBI/cartório?</Label>
            <select id="finance_itbi" className={SELECT_CLASS} {...register("finance_itbi")}>
              <option value="">— selecione —</option>
              {YES_NO.map((y) => (
                <option key={y} value={y}>
                  {y}
                </option>
              ))}
            </select>
          </div>
          <div className="space-y-2">
            <Label htmlFor="has_iq">Possui IQ (imóvel financiado)?</Label>
            <select id="has_iq" className={SELECT_CLASS} {...register("has_iq")}>
              <option value="">— selecione —</option>
              {YES_NO.map((y) => (
                <option key={y} value={y}>
                  {y}
                </option>
              ))}
            </select>
          </div>
          <div className="space-y-2">
            <Label htmlFor="property_location">CEP e nº do imóvel</Label>
            <Input id="property_location" {...register("property_location")} />
          </div>
          <div className="space-y-2">
            <Label htmlFor="objective">O que deseja fazer</Label>
            <Input id="objective" {...register("objective")} />
          </div>
          <div className="space-y-2 sm:col-span-2">
            <Label htmlFor="additional_info">Informações adicionais sobre o imóvel</Label>
            <Input id="additional_info" {...register("additional_info")} />
          </div>
        </div>
      </fieldset>

      {error && <p className="text-sm text-destructive">{error}</p>}

      <div className="flex gap-2">
        <Button type="submit" disabled={isPending}>
          {isPending ? "Salvando..." : "Salvar dados do pedido"}
        </Button>
        <Button
          type="button"
          variant="ghost"
          onClick={() => {
            reset(initial);
            setEditing(false);
          }}
          disabled={isPending}
        >
          Cancelar
        </Button>
      </div>
    </form>
  );
}
