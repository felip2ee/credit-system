import { LogOut } from "lucide-react";

import { signOut } from "@/actions/auth";
import { Button } from "@/components/ui/button";

export function Topbar({ email }: { email: string | null }) {
  return (
    <header className="flex h-16 items-center justify-between border-b bg-background px-6">
      <div className="text-sm text-muted-foreground">{email}</div>
      <form action={signOut}>
        <Button type="submit" variant="ghost" size="sm">
          <LogOut className="h-4 w-4" />
          Sair
        </Button>
      </form>
    </header>
  );
}
