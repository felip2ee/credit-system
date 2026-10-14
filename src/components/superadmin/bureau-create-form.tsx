"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";

import { createBureau } from "@/actions/bureaus";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { bureauCreateSchema, type BureauCreate } from "@/lib/validators/bureau";

export function BureauCreateForm() {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [serverError, setServerError] = useState<string | null>(null);
  const [createdId, setCreatedId] = useState<string | null>(null);

  const {
    register,
    handleSubmit,
    formState: { errors },
  } = useForm<BureauCreate>({
    resolver: zodResolver(bureauCreateSchema),
    defaultValues: { name: "", slug: "", adminName: "", adminEmail: "" },
  });

  const onSubmit = (values: BureauCreate) => {
    setServerError(null);
    setCreatedId(null);
    startTransition(async () => {
      const result = await createBureau(values);
      if (result.error) {
        setServerError(result.error);
        // Bureau criado, e-mail falhou: o usuário segue para reenviar o convite.
        if (result.id) setCreatedId(result.id);
        return;
      }
      router.push(`/superadmin/bureaus/${result.id}`);
    });
  };

  return (
    <form onSubmit={handleSubmit(onSubmit)} className="grid max-w-xl gap-4">
      <div className="space-y-2">
        <Label htmlFor="name">Nome do Bureau</Label>
        <Input id="name" {...register("name")} />
        {errors.name && <p className="text-sm text-destructive">{errors.name.message}</p>}
      </div>
      <div className="space-y-2">
        <Label htmlFor="slug">Endereço (slug)</Label>
        <Input id="slug" placeholder="meu-bureau" {...register("slug")} />
        <p className="text-xs text-muted-foreground">
          Vira /b/slug e não muda depois de criado.
        </p>
        {errors.slug && <p className="text-sm text-destructive">{errors.slug.message}</p>}
      </div>
      <div className="space-y-2">
        <Label htmlFor="adminName">Nome do administrador</Label>
        <Input id="adminName" {...register("adminName")} />
        {errors.adminName && (
          <p className="text-sm text-destructive">{errors.adminName.message}</p>
        )}
      </div>
      <div className="space-y-2">
        <Label htmlFor="adminEmail">E-mail do administrador</Label>
        <Input id="adminEmail" type="email" {...register("adminEmail")} />
        {errors.adminEmail && (
          <p className="text-sm text-destructive">{errors.adminEmail.message}</p>
        )}
      </div>

      {serverError && <p className="text-sm text-destructive">{serverError}</p>}
      {createdId && (
        <Link className="text-sm underline" href={`/superadmin/bureaus/${createdId}`}>
          Abrir o Bureau criado
        </Link>
      )}

      <Button type="submit" disabled={isPending} className="w-fit">
        {isPending ? "Criando..." : "Criar Bureau e convidar admin"}
      </Button>
    </form>
  );
}
