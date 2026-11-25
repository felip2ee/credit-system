"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";

import type { OrderState } from "@/lib/orders/types";

import { createOrderPoller } from "./order-poller";

// Atualiza a página do pedido sozinha enquanto ele anda. Não desenha nada.
export function OrderAutoRefresh({ orderId, initialState }: { orderId: string; initialState: OrderState }) {
	const router = useRouter();

	useEffect(() => {
		const poller = createOrderPoller(initialState, {
			fetchStatus: async () => {
				const res = await fetch(`/api/portal/pesquisas/${orderId}/status`, { cache: "no-store", credentials: "same-origin" });
				const body = res.ok ? ((await res.json()) as { state?: OrderState }) : null;
				return { status: res.status, state: body?.state };
			},
			refresh: () => router.refresh(),
			isHidden: () => document.hidden,
			setTimer: (fn, ms) => setTimeout(fn, ms),
			clearTimer: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
		});
		const onVisibility = () => {
			if (!document.hidden) poller.wake();
		};
		document.addEventListener("visibilitychange", onVisibility);
		poller.start();
		return () => {
			document.removeEventListener("visibilitychange", onVisibility);
			poller.stop();
		};
	}, [orderId, initialState, router]);

	return null;
}
