import Link from "next/link";
import { SearchX } from "lucide-react";

import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";

export default function NotFound() {
  return (
    <main className="mx-auto flex min-h-[60vh] max-w-xl flex-col justify-center p-6">
      <EmptyState
        icon={SearchX}
        title="Página não encontrada"
        description="O endereço pode estar errado ou a página não existe mais."
        action={
          <Button asChild>
            <Link href="/">Voltar ao início</Link>
          </Button>
        }
      />
    </main>
  );
}
