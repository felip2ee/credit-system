"use client";

import { useEffect, useRef } from "react";

import { signOut } from "@/actions/auth";

const IDLE_MS = 30 * 60 * 1000; // 30 minutos
const THROTTLE_MS = 5000;

export function IdleTimeout() {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    let lastReset = 0;

    const reset = () => {
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => {
        void signOut();
      }, IDLE_MS);
    };

    const onActivity = () => {
      const now = Date.now();
      if (now - lastReset < THROTTLE_MS) return;
      lastReset = now;
      reset();
    };

    const events = [
      "mousemove",
      "mousedown",
      "keydown",
      "scroll",
      "touchstart",
    ];
    events.forEach((e) =>
      window.addEventListener(e, onActivity, { passive: true })
    );
    reset();

    return () => {
      if (timer.current) clearTimeout(timer.current);
      events.forEach((e) => window.removeEventListener(e, onActivity));
    };
  }, []);

  return null;
}
