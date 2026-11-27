"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";

import { createHolder, lookupCnpj, updateHolder } from "@/actions/holders";
import { holderFormSchema, type HolderFormValues } from "@/lib/validators/holder";
import type { HolderRow } from "@/lib/holders/queries";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog } from "@/components/ui/dialog";
import { Field } from "@/components/ui/field";
import { Label } from "@/components/ui/label";
import { ScreenHeader } from "@/components/ui/screen-header";
import { formatCNPJ, formatCPF } from "@/lib/utils";
import type { EntityKind } from "@/types/app";

interface HolderFormProps {
  initial?: HolderRow;
}

function toFormValues(c?: HolderRow): HolderFormValues {
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
    addressNumber: c?.address_number ?? "",
    addressComplement: c?.address_complement ?? "",
    neighborhood: c?.neighborhood ?? "",
    city: c?.city ?? "",
    state: c?.state ?? "",
    zipCode: c?.zip_code ?? "",
    notes: c?.notes ?? "",
  };
}

export function HolderForm({ initial }: HolderFormProps) {
  const router = useRouter();
  const isEdit = Boolean(initial);
  const [isPending, startTransition] = useTransition();
  const [serverError, setServerError] = useState<string | null>(null);
  const [lookupMsg, setLookupMsg] = useState<string | null>(null);
  const [confirmLeave, setConfirmLeave] = useState(false);
  const backHref = initial ? `/holders/${initial.id}` : "/holders";

  const {
    register,
    handleSubmit,
    watch,
    setValue,
    getValues,
    formState: { errors, isDirty },
  } = useForm<HolderFormValues>({
    resolver: zodResolver(holderFormSchema),
    defaultValues: toFormValues(initial),
  });

  const type = watch("type");

  const setType = (t: EntityKind) => {
    if (isEdit) return;
    setValue("type", t);
    setValue("document", "", { shouldDirty: true });
  };

  const onDocumentChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const formatted =
      type === "PJ" ? formatCNPJ(e.target.value) : formatCPF(e.target.value);
    setValue("document", formatted, { shouldDirty: true });
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
      setValue("name", d.name, { shouldDirty: true });
      if (d.email) setValue("email", d.email, { shouldDirty: true });
      if (d.phone) setValue("phone", d.phone, { shouldDirty: true });
      if (d.address) setValue("address", d.address, { shouldDirty: true });
      if (d.address_number) setValue("addressNumber", d.address_number, { shouldDirty: true });
      if (d.neighborhood) setValue("neighborhood", d.neighborhood, { shouldDirty: true });
      if (d.city) setValue("city", d.city, { shouldDirty: true });
      if (d.state) setValue("state", d.state, { shouldDirty: true });
      if (d.zip_code) setValue("zipCode", d.zip_code, { shouldDirty: true });
      setLookupMsg(`Dados carregados${d.situacao ? ` — ${d.situacao}` : ""}.`);
    });
  };

  const onSubmit = (values: HolderFormValues) => {
    setServerError(null);
    startTransition(async () => {
      const result = isEdit
        ? await updateHolder(initial!.id, values)
        : await createHolder(values);
      if (result.error) {
        setServerError(result.error);
        return;
      }
      router.push(`/holders/${result.id}`);
      router.refresh();
    });
  };

  // Dados digitados não se perdem em silêncio: pede confirmação antes de sair.
  const goBack = () => (isDirty && !isPending ? setConfirmLeave(true) : router.push(backHref));

  return (
    <div className="md:max-w-3xl">
      <ScreenHeader
        title={isEdit ? "Editar titular" : "Novo titular"}
        onBack={goBack}
        backLabel={isEdit ? "Voltar ao titular" : "Voltar à lista de titulares"}
        className="-mx-4 -mt-4 mb-4 px-1 md:static md:mx-0 md:mt-0 md:mb-6 md:px-0"
      />
      <form onSubmit={handleSubmit(onSubmit)} className="space-y-6">
        {isEdit && <p className="text-sm text-muted-foreground">Editando: {initial?.name}</p>}
        <div role="group" aria-labelledby="holder-type-label" className="space-y-1.5">
          <Label id="holder-type-label">Tipo de titular</Label>
          <div className="flex gap-2">
            {(["PF", "PJ"] as const).map((t) => (
              <Button
                key={t}
                type="button"
                variant={type === t ? "default" : "outline"}
                aria-pressed={type === t}
                onClick={() => setType(t)}
                disabled={isEdit}
              >
                {t === "PF" ? "Pessoa Física" : "Pessoa Jurídica"}
              </Button>
            ))}
          </div>
          <p className="text-sm text-muted-foreground">
            {isEdit
              ? "O tipo e o documento não mudam depois do cadastro. Para corrigir, cadastre um novo titular."
              : "Pessoa física é uma pessoa com CPF. Pessoa jurídica é uma empresa com CNPJ."}
          </p>
        </div>

        <Field
          id="document"
          label={type === "PJ" ? "CNPJ" : "CPF"}
          error={errors.document?.message}
          helper={lookupMsg ?? undefined}
        >
          {(a11y) => (
            <div className="flex gap-2">
              <Input
                {...a11y}
                inputMode="numeric"
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
          )}
        </Field>

        <Field id="name" label={type === "PJ" ? "Razão social" : "Nome completo"} error={errors.name?.message}>
          {(a11y) => <Input {...a11y} {...register("name")} />}
        </Field>

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field id="email" label="E-mail" error={errors.email?.message}>
            {(a11y) => <Input {...a11y} type="email" {...register("email")} />}
          </Field>
          <Field id="phone" label="WhatsApp" error={errors.phone?.message}>
            {(a11y) => <Input {...a11y} type="tel" placeholder="(00) 00000-0000" {...register("phone")} />}
          </Field>
        </div>

        {serverError && (
          <p role="alert" className="text-sm font-bold text-destructive">
            {serverError}
          </p>
        )}

        <Button type="submit" disabled={isPending}>
          {isPending ? "Salvando..." : isEdit ? "Salvar alterações" : "Cadastrar titular"}
        </Button>
      </form>

      <Dialog open={confirmLeave} onClose={() => setConfirmLeave(false)} title="Sair sem salvar?" role="alertdialog">
        <p className="text-sm text-muted-foreground">Os dados digitados serão perdidos.</p>
        <div className="flex justify-end gap-2">
          <Button type="button" variant="outline" onClick={() => setConfirmLeave(false)}>
            Continuar editando
          </Button>
          <Button type="button" variant="destructive" onClick={() => router.push(backHref)}>
            Sair sem salvar
          </Button>
        </div>
      </Dialog>
    </div>
  );
}
