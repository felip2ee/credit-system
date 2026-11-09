"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { getChargeStatusAction } from "@/actions/checkout-context";

export const POLL_INTERVAL_MS = 3000;
export const POLL_TIMEOUT_MS = 60000;

export type PollOutcome = "paid" | "expired" | "cancelled" | "refunded" | "timeout" | "aborted";

type FetchStatus = (id: string) => Promise<{ error: string | null; status?: string }>;

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => { clearTimeout(timer); resolve(); }, { once: true });
  });
}

/** Consulta o status a cada `intervalMs` até sair de "pending" ou passar `timeoutMs`. Erro de consulta não encerra: tenta de novo. */
export async function pollChargeStatus(
  id: string,
  fetchStatus: FetchStatus,
  signal: AbortSignal,
  { intervalMs = POLL_INTERVAL_MS, timeoutMs = POLL_TIMEOUT_MS } = {},
): Promise<PollOutcome> {
  for (let elapsed = 0; elapsed < timeoutMs; elapsed += intervalMs) {
    await sleep(intervalMs, signal);
    if (signal.aborted) return "aborted";
    const res = await fetchStatus(id).catch(() => ({ error: "falha", status: undefined }));
    if (signal.aborted) return "aborted";
    if (res.status === "paid" || res.status === "expired" || res.status === "cancelled" || res.status === "refunded") {
      return res.status;
    }
  }
  return "timeout";
}

export type PollState = { phase: "idle" } | { phase: "polling" } | { phase: "done"; outcome: PollOutcome };

export function useChargePolling(onSettled?: (outcome: PollOutcome) => void) {
  const [state, setState] = useState<PollState>({ phase: "idle" });
  const controller = useRef<AbortController | null>(null);
  const settled = useRef(onSettled);
  settled.current = onSettled;

  useEffect(() => () => controller.current?.abort(), []);

  const start = useCallback((id: string) => {
    controller.current?.abort();
    const ctl = new AbortController();
    controller.current = ctl;
    setState({ phase: "polling" });
    void pollChargeStatus(id, getChargeStatusAction, ctl.signal).then((outcome) => {
      if (outcome === "aborted") return;
      setState({ phase: "done", outcome });
      settled.current?.(outcome);
    });
  }, []);

  return { state, start };
}
