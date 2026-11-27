"use client";

import { useRouter } from "next/navigation";

import { ScreenHeader } from "@/components/ui/screen-header";

export interface LegalBackHeaderProps {
  title: string;
}

// Termos e política abrem em nova aba a partir do cadastro (sem histórico): "Voltar" leva ao login.
export function LegalBackHeader({ title }: LegalBackHeaderProps) {
  const router = useRouter();
  const goBack = () => {
    if (window.history.length > 1) router.back();
    else router.push("/login");
  };
  return <ScreenHeader className="-mx-4 min-[375px]:-mx-5" title={title} onBack={goBack} />;
}
