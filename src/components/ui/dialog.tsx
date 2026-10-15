"use client";

import * as React from "react";

import { cn } from "@/lib/utils";

interface DialogProps {
  open: boolean;
  onClose: () => void;
  title: string;
  // "alertdialog" para confirmações destrutivas.
  role?: "dialog" | "alertdialog";
  // false enquanto uma ação está em andamento: bloqueia Escape.
  dismissible?: boolean;
  className?: string;
  children: React.ReactNode;
}

// Modal sobre o <dialog> nativo: showModal() dá trap de foco, Escape, fundo inerte, bloqueio de scroll
// e devolve o foco ao elemento que abriu. O conteúdo só monta com o diálogo aberto (estado zera a cada abertura).
export function Dialog({
  open,
  onClose,
  title,
  role = "dialog",
  dismissible = true,
  className,
  children,
}: DialogProps) {
  const ref = React.useRef<HTMLDialogElement>(null);
  const titleId = React.useId();

  React.useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (open && !el.open) el.showModal();
    if (!open && el.open) el.close();
  }, [open]);

  return (
    <dialog
      ref={ref}
      role={role}
      aria-labelledby={titleId}
      onCancel={(e) => {
        e.preventDefault();
        if (dismissible) onClose();
      }}
      className={cn(
        "m-auto w-full max-w-md rounded-lg bg-background p-6 text-foreground shadow-lg backdrop:bg-black/50",
        className,
      )}
    >
      {open && (
        <div className="space-y-4">
          <h2 id={titleId} className="text-lg font-semibold">
            {title}
          </h2>
          {children}
        </div>
      )}
    </dialog>
  );
}
