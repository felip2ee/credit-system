"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { Pencil } from "lucide-react";

import { updateOpportunityDetails } from "@/actions/opportunities";
import {
  opportunityDetailsFormSchema,
  type OpportunityDetailsFormValues,
} from "@/lib/validators/opportunity";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  formatCNPJ,
  formatCPF,
  formatCurrency,
  formatDate,
} from "@/lib/utils";
import type { CreditProduct, EntityKind, Opportunity } from "@/types/app";

interface Props {
  opportunity: Opportunity;
  products: CreditProduct[];
  entityKind: EntityKind;
}

function toForm(o: Opportunity): OpportunityDetailsFormValues {
  return {
    credit_product_id: o.credit_product_id ?? "",
    cnpj: o.cnpj ?? "",
    credit_purpose: o.credit_purpose ?? "",
    requested_amount:
      o.requested_amount != null ? String(o.requested_amount) : "",
    monthly_revenue: o.monthly_revenue != null ? String(o.monthly_revenue) : "",
    responsible_name: o.responsible_name ?? "",
    responsible_email: o.responsible_email ?? "",
    responsible_phone: o.responsible_phone ?? "",
    responsible_cpf: o.responsible_cpf ?? "",
    responsible_birth_date: o.responsible_birth_date ?? "",
    responsible_mother_name: o.responsible_mother_name ?? "",
    address: o.address ?? "",
    address_number: o.address_number ?? "",
    address_complement: o.address_complement ?? "",
    neighborhood: o.neighborhood ?? "",
    city: o.city ?? "",
    state: o.state ?? "",
    zip_code: o.zip_code ?? "",
    partner_name: o.partner_name ?? "",
    partner_notes: o.partner_notes ?? "",
    notes: o.notes ?? "",
  };
}

function Field({ label, value }: { label: string; value: string | null }) {
  return (
    <div>
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="text-sm">{value || "—"}</dd>
    </div>
  );
}

export function OpportunityForm({ opportunity, products, entityKind }: Props) {
  const isPF = entityKind === "PF";
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const [isPending, startTransition] = useTransition();
  const [serverError, setServerError] = useState<string | null>(null);

  const {
    register,
    handleSubmit,
    reset,
    formState: { errors },
  } = useForm<OpportunityDetailsFormValues>({
    resolver: zodResolver(opportunityDetailsFormSchema),
    defaultValues: toForm(opportunity),
  });

  const startEditing = () => {
    reset(toForm(opportunity));
    setServerError(null);
    setEditing(true);
  };

  const cancelEditing = () => {
    reset(toForm(opportunity));
    setServerError(null);
    setEditing(false);
  };

  const onSubmit = (values: OpportunityDetailsFormValues) => {
    setServerError(null);
    startTransition(async () => {
      const res = await updateOpportunityDetails(opportunity.id, values);
      if (res.error) {
        setServerError(res.error);
        return;
      }
      setEditing(false);
      router.refresh();
    });
  };

  // ── Modo leitura ──────────────────────────────────────────────────────────
  if (!editing) {
    const productName =
      products.find((p) => p.id === opportunity.credit_product_id)?.name ?? null;
    const fullAddress = [
      opportunity.address,
      opportunity.address_number,
      opportunity.neighborhood,
      opportunity.city && opportunity.state
        ? `${opportunity.city}/${opportunity.state}`
        : opportunity.city,
      opportunity.zip_code,
    ]
      .filter(Boolean)
      .join(", ");

    return (
      <div className="space-y-5">
        <div className="flex justify-end">
          <Button variant="outline" size="sm" onClick={startEditing}>
            <Pencil className="h-4 w-4" />
            Editar
          </Button>
        </div>

        <dl className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field label="Produto de crédito" value={productName} />
          {!isPF && (
            <Field
              label="CNPJ"
              value={opportunity.cnpj ? formatCNPJ(opportunity.cnpj) : null}
            />
          )}
          <Field label="Finalidade do crédito" value={opportunity.credit_purpose} />
          <Field
            label="Valor solicitado"
            value={
              opportunity.requested_amount != null
                ? formatCurrency(opportunity.requested_amount)
                : null
            }
          />
          {!isPF && (
            <Field
              label="Faturamento mensal"
              value={
                opportunity.monthly_revenue != null
                  ? formatCurrency(opportunity.monthly_revenue)
                  : null
              }
            />
          )}
        </dl>

        <div>
          <p className="mb-2 text-sm font-medium">Responsável</p>
          <dl className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Field label="Nome" value={opportunity.responsible_name} />
            <Field
              label="CPF"
              value={
                opportunity.responsible_cpf
                  ? formatCPF(opportunity.responsible_cpf)
                  : null
              }
            />
            <Field
              label="Data de nascimento"
              value={
                opportunity.responsible_birth_date
                  ? formatDate(opportunity.responsible_birth_date)
                  : null
              }
            />
            <Field label="Nome da mãe" value={opportunity.responsible_mother_name} />
            <Field label="E-mail" value={opportunity.responsible_email} />
            <Field label="Telefone com DDD" value={opportunity.responsible_phone} />
          </dl>
        </div>

        <div>
          <p className="mb-2 text-sm font-medium">Endereço</p>
          <p className="text-sm">{fullAddress || "—"}</p>
        </div>

        <div>
          <p className="mb-2 text-sm font-medium">Parceiro / instituição</p>
          <dl className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Field label="Parceiro destino" value={opportunity.partner_name} />
            <Field label="Observações do parceiro" value={opportunity.partner_notes} />
          </dl>
        </div>

        <Field label="Observações gerais" value={opportunity.notes} />
      </div>
    );
  }

  // ── Modo edição ─────────────────────────────────────────────────────────────
  return (
    <form onSubmit={handleSubmit(onSubmit)} className="space-y-5">
      <div className="space-y-2">
        <Label htmlFor="credit_product_id">Produto de crédito</Label>
        <select
          id="credit_product_id"
          {...register("credit_product_id")}
          className="flex h-10 w-full rounded-md border border-input bg-background px-3 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
        >
          <option value="">— selecione —</option>
          {products.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
      </div>

      {!isPF && (
        <div className="space-y-2">
          <Label htmlFor="cnpj">CNPJ</Label>
          <Input id="cnpj" placeholder="00.000.000/0000-00" {...register("cnpj")} />
        </div>
      )}

      <div className="space-y-2">
        <Label htmlFor="credit_purpose">Finalidade do crédito</Label>
        <Input id="credit_purpose" {...register("credit_purpose")} />
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <div className="space-y-2">
          <Label htmlFor="requested_amount">Valor solicitado (R$)</Label>
          <Input
            id="requested_amount"
            placeholder="0,00"
            {...register("requested_amount")}
          />
        </div>
        {!isPF && (
          <div className="space-y-2">
            <Label htmlFor="monthly_revenue">Faturamento mensal (R$)</Label>
            <Input
              id="monthly_revenue"
              placeholder="0,00"
              {...register("monthly_revenue")}
            />
          </div>
        )}
      </div>

      <fieldset className="space-y-4 rounded-md border p-4">
        <legend className="px-1 text-sm font-medium">Responsável</legend>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div className="space-y-2">
            <Label htmlFor="responsible_name">Nome</Label>
            <Input id="responsible_name" {...register("responsible_name")} />
          </div>
          <div className="space-y-2">
            <Label htmlFor="responsible_cpf">CPF</Label>
            <Input id="responsible_cpf" {...register("responsible_cpf")} />
          </div>
          <div className="space-y-2">
            <Label htmlFor="responsible_birth_date">Data de nascimento</Label>
            <Input
              id="responsible_birth_date"
              type="date"
              {...register("responsible_birth_date")}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="responsible_mother_name">Nome da mãe</Label>
            <Input
              id="responsible_mother_name"
              {...register("responsible_mother_name")}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="responsible_email">E-mail</Label>
            <Input
              id="responsible_email"
              type="email"
              {...register("responsible_email")}
            />
            {errors.responsible_email && (
              <p className="text-sm text-destructive">
                {errors.responsible_email.message}
              </p>
            )}
          </div>
          <div className="space-y-2">
            <Label htmlFor="responsible_phone">Telefone com DDD</Label>
            <Input id="responsible_phone" {...register("responsible_phone")} />
          </div>
        </div>
      </fieldset>

      <fieldset className="space-y-4 rounded-md border p-4">
        <legend className="px-1 text-sm font-medium">Endereço</legend>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div className="space-y-2">
            <Label htmlFor="zip_code">CEP</Label>
            <Input id="zip_code" placeholder="00000-000" {...register("zip_code")} />
          </div>
          <div className="space-y-2">
            <Label htmlFor="address">Endereço</Label>
            <Input id="address" {...register("address")} />
          </div>
          <div className="space-y-2">
            <Label htmlFor="address_number">Número</Label>
            <Input id="address_number" {...register("address_number")} />
          </div>
          <div className="space-y-2">
            <Label htmlFor="address_complement">Complemento</Label>
            <Input
              id="address_complement"
              {...register("address_complement")}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="neighborhood">Bairro</Label>
            <Input id="neighborhood" {...register("neighborhood")} />
          </div>
          <div className="space-y-2">
            <Label htmlFor="city">Cidade</Label>
            <Input id="city" {...register("city")} />
          </div>
          <div className="space-y-2">
            <Label htmlFor="state">UF</Label>
            <Input id="state" maxLength={2} placeholder="UF" {...register("state")} />
            {errors.state && (
              <p className="text-sm text-destructive">{errors.state.message}</p>
            )}
          </div>
        </div>
      </fieldset>

      <fieldset className="space-y-4 rounded-md border p-4">
        <legend className="px-1 text-sm font-medium">Parceiro / instituição</legend>
        <div className="space-y-2">
          <Label htmlFor="partner_name">Parceiro destino</Label>
          <Input
            id="partner_name"
            placeholder="Banco / fintech"
            {...register("partner_name")}
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="partner_notes">Observações do parceiro</Label>
          <Input id="partner_notes" {...register("partner_notes")} />
        </div>
      </fieldset>

      <div className="space-y-2">
        <Label htmlFor="notes">Observações gerais</Label>
        <Input id="notes" {...register("notes")} />
      </div>

      {serverError && <p className="text-sm text-destructive">{serverError}</p>}

      <div className="flex gap-2">
        <Button type="submit" disabled={isPending}>
          {isPending ? "Salvando..." : "Salvar detalhes"}
        </Button>
        <Button
          type="button"
          variant="ghost"
          onClick={cancelEditing}
          disabled={isPending}
        >
          Cancelar
        </Button>
      </div>
    </form>
  );
}
