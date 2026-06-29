"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";

import { setUserActive } from "@/actions/users";
import { Button } from "@/components/ui/button";

interface UserRowActionsProps {
  userId: string;
  isActive: boolean;
  disabled?: boolean;
}

export function UserRowActions({
  userId,
  isActive,
  disabled,
}: UserRowActionsProps) {
  const [isPending, startTransition] = useTransition();
  const router = useRouter();

  const toggle = () => {
    startTransition(async () => {
      await setUserActive(userId, !isActive);
      router.refresh();
    });
  };

  return (
    <Button
      variant={isActive ? "outline" : "secondary"}
      size="sm"
      onClick={toggle}
      disabled={disabled || isPending}
    >
      {isPending ? "..." : isActive ? "Desativar" : "Ativar"}
    </Button>
  );
}
