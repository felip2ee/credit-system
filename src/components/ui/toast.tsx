"use client";

import * as React from "react";
import * as ToastPrimitive from "@radix-ui/react-toast";
import { X } from "lucide-react";

import { cn } from "@/lib/utils";

import { STATE_TONE_ICON, toneStyle, type StateTone } from "./state-tone";

export const TOAST_DURATION_MS = 6000;
export interface ToastInput {
  tone: StateTone;
  title: string;
  description?: string;
}
interface ToastItem extends ToastInput {
  id: number;
}

// Store mínimo fora do React: toast() pode ser chamado de qualquer lugar do cliente.
let items: ToastItem[] = [];
let nextId = 1;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

export function toast(input: ToastInput): void {
  items = [...items, { ...input, id: nextId++ }];
  emit();
}

function dismiss(id: number) {
  items = items.filter((t) => t.id !== id);
  emit();
}

function useToasts(): ToastItem[] {
  return React.useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => items,
    () => items,
  );
}

export function Toaster() {
  const list = useToasts();
  return (
    <ToastPrimitive.Provider duration={TOAST_DURATION_MS} label="Avisos" swipeDirection="right">
      {list.map((t) => {
        const Icon = STATE_TONE_ICON[t.tone];
        return (
          <ToastPrimitive.Root
            key={t.id}
            type={t.tone === "danger" || t.tone === "attention" ? "foreground" : "background"}
            style={toneStyle(t.tone)}
            onOpenChange={(open) => !open && dismiss(t.id)}
            className={cn("flex items-start gap-3 rounded-card border p-4 shadow-lg admin:p-3")}
          >
            <Icon aria-hidden className="mt-0.5 size-6 shrink-0" />
            <div className="flex-1 space-y-1">
              <ToastPrimitive.Title className="text-base font-bold admin:text-sm">{t.title}</ToastPrimitive.Title>
              {t.description && (
                <ToastPrimitive.Description className="text-base admin:text-sm">{t.description}</ToastPrimitive.Description>
              )}
            </div>
            <ToastPrimitive.Close
              aria-label="Fechar aviso"
              className="relative -m-2 flex size-11 shrink-0 items-center justify-center rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <X aria-hidden className="size-5" />
            </ToastPrimitive.Close>
          </ToastPrimitive.Root>
        );
      })}
      <ToastPrimitive.Viewport className="fixed inset-x-0 bottom-0 z-[100] m-0 flex list-none flex-col gap-2 p-4 sm:left-auto sm:max-w-md" />
    </ToastPrimitive.Provider>
  );
}
