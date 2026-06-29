"use client";

import { useState } from "react";
import Link from "next/link";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";

import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { createClient } from "@/lib/supabase/client";

const schema = z.object({
  email: z.string().email("Informe um e-mail válido."),
});

type FormValues = z.infer<typeof schema>;

export default function ResetPasswordPage() {
  const supabase = createClient();
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: { email: "" },
  });

  const onSubmit = async (values: FormValues) => {
    setError(null);
    const { error } = await supabase.auth.resetPasswordForEmail(values.email, {
      redirectTo: `${window.location.origin}/auth/callback?next=/update-password`,
    });
    if (error) {
      setError("Não foi possível enviar o e-mail. Tente novamente.");
      return;
    }
    setSent(true);
  };

  return (
    <Card className="w-full max-w-sm">
      <CardHeader className="space-y-1 text-center">
        <CardTitle className="text-2xl">Recuperar senha</CardTitle>
        <CardDescription>
          Enviaremos um link de redefinição por e-mail
        </CardDescription>
      </CardHeader>
      <CardContent>
        {sent ? (
          <div className="space-y-4 text-center">
            <p className="text-sm text-muted-foreground">
              Se houver uma conta com esse e-mail, um link de redefinição foi
              enviado. Verifique sua caixa de entrada.
            </p>
            <Button asChild variant="outline" className="w-full">
              <Link href="/login">Voltar ao login</Link>
            </Button>
          </div>
        ) : (
          <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="email">E-mail</Label>
              <Input
                id="email"
                type="email"
                autoComplete="email"
                {...register("email")}
              />
              {errors.email && (
                <p className="text-sm text-destructive">
                  {errors.email.message}
                </p>
              )}
            </div>
            {error && <p className="text-sm text-destructive">{error}</p>}
            <Button type="submit" className="w-full" disabled={isSubmitting}>
              {isSubmitting ? "Enviando..." : "Enviar link"}
            </Button>
            <Button asChild variant="ghost" className="w-full">
              <Link href="/login">Voltar ao login</Link>
            </Button>
          </form>
        )}
      </CardContent>
    </Card>
  );
}
