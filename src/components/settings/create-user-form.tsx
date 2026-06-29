"use client";

import { useState, useTransition } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";

import { createConsultant } from "@/actions/users";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

const schema = z.object({
  fullName: z.string().min(3, "Informe o nome completo."),
  email: z.string().email("E-mail inválido."),
  role: z.enum(["consultant", "admin"]),
});

type FormValues = z.infer<typeof schema>;

interface CreatedUser {
  email: string;
  tempPassword: string;
}

export function CreateUserForm() {
  const [isPending, startTransition] = useTransition();
  const [serverError, setServerError] = useState<string | null>(null);
  const [created, setCreated] = useState<CreatedUser | null>(null);

  const {
    register,
    handleSubmit,
    reset,
    formState: { errors },
  } = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: { fullName: "", email: "", role: "consultant" },
  });

  const onSubmit = (values: FormValues) => {
    setServerError(null);
    setCreated(null);
    startTransition(async () => {
      const result = await createConsultant(
        values.fullName,
        values.email,
        values.role
      );
      if (result.error) {
        setServerError(result.error);
        return;
      }
      setCreated({ email: result.email!, tempPassword: result.tempPassword! });
      reset();
    });
  };

  return (
    <div className="space-y-4">
      <form
        onSubmit={handleSubmit(onSubmit)}
        className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4 lg:items-end"
      >
        <div className="space-y-2">
          <Label htmlFor="fullName">Nome completo</Label>
          <Input id="fullName" {...register("fullName")} />
          {errors.fullName && (
            <p className="text-sm text-destructive">{errors.fullName.message}</p>
          )}
        </div>

        <div className="space-y-2">
          <Label htmlFor="email">E-mail</Label>
          <Input id="email" type="email" {...register("email")} />
          {errors.email && (
            <p className="text-sm text-destructive">{errors.email.message}</p>
          )}
        </div>

        <div className="space-y-2">
          <Label htmlFor="role">Perfil</Label>
          <select
            id="role"
            className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
            {...register("role")}
          >
            <option value="consultant">Consultor</option>
            <option value="admin">Administrador</option>
          </select>
        </div>

        <Button type="submit" disabled={isPending}>
          {isPending ? "Criando..." : "Criar usuário"}
        </Button>
      </form>

      {serverError && <p className="text-sm text-destructive">{serverError}</p>}

      {created && (
        <div className="rounded-md border border-emerald-200 bg-emerald-50 p-4 text-sm">
          <p className="font-medium text-emerald-900">
            Usuário criado: {created.email}
          </p>
          <p className="mt-1 text-emerald-800">
            Senha temporária:{" "}
            <code className="rounded bg-emerald-100 px-1.5 py-0.5 font-mono">
              {created.tempPassword}
            </code>
          </p>
          <p className="mt-1 text-emerald-700">
            Repasse com segurança — o usuário deve trocá-la no primeiro acesso.
          </p>
        </div>
      )}
    </div>
  );
}
