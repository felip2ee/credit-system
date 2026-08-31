"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";

import { authClient } from "@/lib/auth/client";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

const loginSchema = z.object({
  email: z.string().email("Informe um e-mail válido."),
  password: z.string().min(12, "A senha deve ter ao menos 12 caracteres."),
});
type LoginValues = z.infer<typeof loginSchema>;

function callbackPath(value: string | null): string {
  return value?.startsWith("/") && !value.startsWith("//") ? value : "/";
}

export default function LoginPage() {
  const searchParams = useSearchParams();
  const [serverError, setServerError] = useState<string | null>(null);
  const { register, handleSubmit, formState: { errors, isSubmitting } } = useForm<LoginValues>({
    resolver: zodResolver(loginSchema), defaultValues: { email: "", password: "" },
  });
  const onSubmit = async (values: LoginValues) => {
    setServerError(null);
    const result = await authClient.signIn.email({ ...values, callbackURL: callbackPath(searchParams.get("next")) });
    if (result.error) setServerError("E-mail ou senha inválidos.");
  };
  return <Card className="w-full max-w-sm"><CardHeader className="space-y-1 text-center"><CardTitle className="text-2xl">Reino do Crédito</CardTitle><CardDescription>Acesse o painel do consultor</CardDescription></CardHeader><CardContent><form onSubmit={handleSubmit(onSubmit)} className="space-y-4"><div className="space-y-2"><Label htmlFor="email">E-mail</Label><Input id="email" type="email" autoComplete="email" {...register("email")} />{errors.email && <p className="text-sm text-destructive">{errors.email.message}</p>}</div><div className="space-y-2"><Label htmlFor="password">Senha</Label><Input id="password" type="password" autoComplete="current-password" {...register("password")} />{errors.password && <p className="text-sm text-destructive">{errors.password.message}</p>}</div>{serverError && <p className="text-sm text-destructive">{serverError}</p>}<Button type="submit" className="w-full" disabled={isSubmitting}>{isSubmitting ? "Entrando..." : "Entrar"}</Button><div className="text-center"><Link href="/reset-password" className="text-sm text-muted-foreground underline-offset-4 hover:underline">Esqueci minha senha</Link></div></form></CardContent></Card>;
}
