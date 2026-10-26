"use client";

import { useState, useTransition } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";

import { inviteTeamMember } from "@/actions/users";
import { PasswordInput } from "@/components/auth/password-input";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
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
          <Select value={watch("role")} onValueChange={(value) => setValue("role", value as FormValues["role"])}>
            <SelectTrigger id="role">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="operator">Operador</SelectItem>
              <SelectItem value="bureau_admin">Administrador</SelectItem>
            </SelectContent>
          </Select>
        </div>

        <div className="space-y-2">
          <Label htmlFor="password">Senha (opcional)</Label>
          <PasswordInput id="password" {...register("password")} />
          {errors.password && (
            <p className="text-sm text-destructive">{errors.password.message}</p>
          )}
        </div>

        <div className="space-y-2">
          <Label htmlFor="confirm">Confirmar senha</Label>
          <PasswordInput id="confirm" {...register("confirm")} />
          {errors.confirm && (
            <p className="text-sm text-destructive">{errors.confirm.message}</p>
          )}
        </div>

        <p className="text-sm text-muted-foreground sm:col-span-2">
          Deixe em branco para enviar o convite por e-mail. Com senha, o usuário troca
          a senha no primeiro acesso.
        </p>

        <Button type="submit" disabled={isPending}>
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
