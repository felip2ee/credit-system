"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";

import {
  createClientRecord,
  lookupCnpj,
  updateClientRecord,
} from "@/actions/clients";
import {
  clientFormSchema,
  type ClientFormValues,
} from "@/lib/validators/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { formatCNPJ, formatCPF } from "@/lib/utils";
import type { CrmClient, EntityKind } from "@/types/app";

interface ClientFormProps {
  initial?: CrmClient;
}

function toFormValues(c?: CrmClient): ClientFormValues {
  return {
    type: c?.type ?? "PF",
    name: c?.name ?? "",
    document: c?.document
      ? c.type === "PJ"
        ? formatCNPJ(c.document)
        : formatCPF(c.document)
      : "",
    email: c?.email ?? "",
    phone: c?.phone ?? "",
    address: c?.address ?? "",
    address_number: c?.address_number ?? "",
    address_complement: c?.address_complement ?? "",
    neighborhood: c?.neighborhood ?? "",
    city: c?.city ?? "",
    state: c?.state ?? "",
    zip_code: c?.zip_code ?? "",
    status: c?.status ?? "prospect",
    notes: c?.notes ?? "",
  };
}

export function ClientForm({ initial }: ClientFormProps) {
  const router = useRouter();
  const isEdit = Boolean(initial);
  const [isPending, startTransition] = useTransition();
  const [serverError, setServerError] = useState<string | null>(null);
  const [lookupMsg, setLookupMsg] = useState<string | null>(null);

  const {
    register,
    handleSubmit,
    watch,
    setValue,
    getValues,
    formState: { errors },
  } = useForm<ClientFormValues>({
    resolver: zodResolver(clientFormSchema),
    defaultValues: toFormValues(initial),
  });

  const type = watch("type");

  const setType = (t: EntityKind) => {
    if (isEdit) return;
    setValue("type", t);
    setValue("document", "");
  };

  const onDocumentChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const formatted =
      type === "PJ" ? formatCNPJ(e.target.value) : formatCPF(e.target.value);
    setValue("document", formatted);
  };

  const handleLookup = () => {
    setLookupMsg(null);
    setServerError(null);
    startTransition(async () => {
      const result = await lookupCnpj(getValues("document"));
      if (result.error || !result.data) {
        setLookupMsg(result.error ?? "Falha na consulta.");
        return;
      }
      const d = result.data;
      setValue("name", d.name);
      if (d.email) setValue("email", d.email);
      if (d.phone) setValue("phone", d.phone);
      if (d.address) setValue("address", d.address);
      if (d.address_number) setValue("address_number", d.address_number);
      if (d.neighborhood) setValue("neighborhood", d.neighborhood);
      if (d.city) setValue("city", d.city);
      if (d.state) setValue("state", d.state);
      if (d.zip_code) setValue("zip_code", d.zip_code);
      setLookupMsg(`Dados carregados${d.situacao ? ` — ${d.situacao}` : ""}.`);
    });
  };

  const onSubmit = (values: ClientFormValues) => {
    setServerError(null);
    startTransition(async () => {
      const result = isEdit
        ? await updateClientRecord(initial!.id, values)
        : await createClientRecord(values);
      if (result.error) {
        setServerError(result.error);
        return;
      }
      router.push(`/clients/${result.id}`);
      router.refresh();
    });
  };

  return (
    <form onSubmit={handleSubmit(onSubmit)} className="space-y-6">
      {/* Tipo */}
      <div className="space-y-2">
        <Label>Tipo de cliente</Label>
        <div className="flex gap-2">
          {(["PF", "PJ"] as const).map((t) => (
            <Button
              key={t}
              type="button"
              variant={type === t ? "default" : "outline"}
              onClick={() => setType(t)}
              disabled={isEdit}
            >
              {t === "PF" ? "Pessoa Física" : "Pessoa Jurídica"}
            </Button>
          ))}
        </div>
      </div>

      {/* Documento */}
      <div className="space-y-2">
        <Label htmlFor="document">{type === "PJ" ? "CNPJ" : "CPF"}</Label>
        <div className="flex gap-2">
          <Input
            id="document"
            value={watch("document")}
            onChange={onDocumentChange}
            disabled={isEdit}
            placeholder={type === "PJ" ? "00.000.000/0000-00" : "000.000.000-00"}
          />
          {type === "PJ" && !isEdit && (
            <Button type="button" variant="secondary" onClick={handleLookup} disabled={isPending}>
              Buscar na Receita
            </Button>
          )}
        </div>
        {errors.document && (
          <p className="text-sm text-destructive">{errors.document.message}</p>
        )}
        {lookupMsg && <p className="text-sm text-muted-foreground">{lookupMsg}</p>}
      </div>

      {/* Nome / Razão social */}
      <div className="space-y-2">
        <Label htmlFor="name">
          {type === "PJ" ? "Razão social" : "Nome completo"}
        </Label>
        <Input id="name" {...register("name")} />
        {errors.name && (
          <p className="text-sm text-destructive">{errors.name.message}</p>
        )}
      </div>

      {/* Contato */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <div className="space-y-2">
          <Label htmlFor="email">E-mail</Label>
          <Input id="email" type="email" {...register("email")} />
          {errors.email && (
            <p className="text-sm text-destructive">{errors.email.message}</p>
          )}
        </div>
        <div className="space-y-2">
          <Label htmlFor="phone">WhatsApp</Label>
          <Input id="phone" placeholder="(00) 00000-0000" {...register("phone")} />
        </div>
      </div>

      {serverError && <p className="text-sm text-destructive">{serverError}</p>}

      <div className="flex gap-2">
        <Button type="submit" disabled={isPending}>
          {isPending ? "Salvando..." : isEdit ? "Salvar alterações" : "Cadastrar cliente"}
        </Button>
        <Button type="button" variant="ghost" onClick={() => router.back()}>
          Cancelar
        </Button>
      </div>
    </form>
  );
}
