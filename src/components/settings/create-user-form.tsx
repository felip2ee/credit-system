"use client";

import { useState, useTransition } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";

import { inviteTeamMember } from "@/actions/users";
import { PasswordInput } from "@/components/auth/password-input";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Field } from "@/components/ui/field";
import { refineOptionalNewPassword } from "@/lib/validators/password";
import { StatusBanner } from "@/components/ui/status-banner";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

const schema = z
  .object({
    fullName: z.string().min(3, "Informe o nome completo."),
    email: z.string().email("E-mail inválido."),
    role: z.enum(["operator", "bureau_admin"]),
    password: z.string(),
    confirm: z.string(),
  })
  .superRefine((v, ctx) =>
    refineOptionalNewPassword(ctx, { password: v.password, confirm: v.confirm, passwordPath: "password" }),
  );

type FormValues = z.infer<typeof schema>;

export function CreateUserForm() {
  const [isPending, startTransition] = useTransition();
  const [serverError, setServerError] = useState<string | null>(null);
  const [created, setCreated] = useState<{ email: string; invited: boolean } | null>(null);

  const {
    register,
    handleSubmit,
    reset,
    resetField,
    watch,
    setValue,
    formState: { errors },
  } = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: {
      fullName: "",
      email: "",
      role: "operator",
      password: "",
      confirm: "",
    },
  });

  const onSubmit = ({ confirm: _confirm, password, ...rest }: FormValues) => {
    const values = { ...rest, password: password || undefined };
    setServerError(null);
    setCreated(null);
    startTransition(async () => {
      const result = await inviteTeamMember(values);
      if (result.error) {
        setServerError(result.error);
        resetField("password");
        resetField("confirm");
        return;
      }
      setCreated({ email: result.email!, invited: result.invited !== false });
      reset();
    });
  };

  return (
    <div className="space-y-4">
      <form onSubmit={handleSubmit(onSubmit)} className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Field id="fullName" label="Nome completo" error={errors.fullName?.message}>
          {(a11y) => <Input {...a11y} {...register("fullName")} />}
        </Field>

        <Field id="email" label="E-mail" error={errors.email?.message}>
          {(a11y) => <Input {...a11y} type="email" {...register("email")} />}
        </Field>

        <Field
          id="role"
          label="Perfil"
          className="sm:col-span-2"
          helper="Operador faz consultas e atende titulares. Administrador faz o mesmo e também gerencia a equipe, vê a auditoria e recarrega a carteira. Depois do convite, só é possível promover Operador a Administrador."
        >
          {(a11y) => (
            <Select value={watch("role")} onValueChange={(value) => setValue("role", value as FormValues["role"])}>
              <SelectTrigger {...a11y}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="operator">Operador</SelectItem>
                <SelectItem value="bureau_admin">Administrador</SelectItem>
              </SelectContent>
            </Select>
          )}
        </Field>

        <Field id="password" label="Senha (opcional)" error={errors.password?.message}>
          {(a11y) => <PasswordInput {...a11y} {...register("password")} />}
        </Field>

        <Field id="confirm" label="Confirmar senha" error={errors.confirm?.message}>
          {(a11y) => <PasswordInput {...a11y} {...register("confirm")} />}
        </Field>

        <p className="text-sm text-muted-foreground sm:col-span-2">
          O que acontece depois: sem senha, enviamos um e-mail com um link para a pessoa criar a senha. Com senha, não
          enviamos e-mail; a pessoa entra com a senha que você definiu e a troca no primeiro acesso. Informe a senha por
          um canal seguro.
        </p>

        <Button type="submit" disabled={isPending} className="w-full sm:col-span-2 sm:w-auto sm:justify-self-start">
          {isPending ? "Enviando..." : "Cadastrar"}
        </Button>
      </form>

      {serverError && <StatusBanner tone="danger" title={serverError} />}

      {created && (
        <StatusBanner
          tone="success"
          title={created.invited ? "Convite enviado" : "Usuário criado"}
          description={
            created.invited
              ? `Um link para definir a senha foi enviado para ${created.email}.`
              : "Ele troca a senha no primeiro acesso. Informe a senha por um canal seguro."
          }
        />
      )}
    </div>
  );
}
