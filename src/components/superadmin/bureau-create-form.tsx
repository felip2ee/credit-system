"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";

import { createBureau } from "@/actions/bureaus";
import { PasswordInput } from "@/components/auth/password-input";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { bureauCreateSchema } from "@/lib/validators/bureau";
import { passwordSchema } from "@/lib/validators/password";

const formSchema = bureauCreateSchema
  .omit({ adminPassword: true })
  .extend({ adminPassword: z.string(), confirm: z.string() })
  .superRefine((v, ctx) => {
    const strength = v.adminPassword ? passwordSchema.safeParse(v.adminPassword) : null;
    if (strength && !strength.success) {
      ctx.addIssue({
        code: "custom",
        message: strength.error.issues[0]?.message ?? "Senha inválida.",
        path: ["adminPassword"],
      });
    }
    if (v.adminPassword !== v.confirm) {
      ctx.addIssue({ code: "custom", message: "As senhas não coincidem.", path: ["confirm"] });
    }
  });
type FormValues = z.infer<typeof formSchema>;

export function BureauCreateForm() {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [serverError, setServerError] = useState<string | null>(null);
  const [createdId, setCreatedId] = useState<string | null>(null);
  const [createdWithPassword, setCreatedWithPassword] = useState(false);

  const {
    register,
    handleSubmit,
    resetField,
    formState: { errors },
  } = useForm<FormValues>({
    resolver: zodResolver(formSchema),
    defaultValues: {
      name: "",
      slug: "",
      adminName: "",
      adminEmail: "",
      adminPassword: "",
      confirm: "",
    },
  });

  const onSubmit = ({ confirm: _confirm, adminPassword, ...rest }: FormValues) => {
    const values = { ...rest, adminPassword: adminPassword || undefined };
    setServerError(null);
    setCreatedId(null);
    setCreatedWithPassword(false);
    startTransition(async () => {
      const result = await createBureau(values);
      resetField("adminPassword");
      resetField("confirm");
      if (result.error) {
        setServerError(result.error);
        // Bureau criado, e-mail falhou: o usuário segue para reenviar o convite.
        if (result.id) setCreatedId(result.id);
        return;
      }
      if (values.adminPassword) {
        // Com senha, a página fica para mostrar o aviso (sem repetir a senha).
        setCreatedId(result.id ?? null);
        setCreatedWithPassword(true);
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
      <div className="space-y-2">
        <Label htmlFor="adminPassword">Senha do administrador</Label>
        <PasswordInput id="adminPassword" {...register("adminPassword")} />
        <p className="text-xs text-muted-foreground">
          Deixe em branco para enviar o convite por e-mail. Com senha, o administrador
          troca a senha no primeiro acesso.
        </p>
        {errors.adminPassword && (
          <p className="text-sm text-destructive">{errors.adminPassword.message}</p>
        )}
      </div>
      <div className="space-y-2">
        <Label htmlFor="confirm">Confirmar senha</Label>
        <PasswordInput id="confirm" {...register("confirm")} />
        {errors.confirm && (
          <p className="text-sm text-destructive">{errors.confirm.message}</p>
        )}
      </div>

      {serverError && <p className="text-sm text-destructive">{serverError}</p>}
      {createdWithPassword && (
        <p className="text-sm text-emerald-600">
          Bureau criado. Informe a senha ao administrador por um canal seguro.
        </p>
      )}
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
