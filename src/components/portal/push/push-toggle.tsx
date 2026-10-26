"use client";

import { useCallback, useEffect, useState } from "react";
import { Bell, BellOff } from "lucide-react";

import { getPushSubscriptionStatusAction, registerPushSubscriptionAction, removePushSubscriptionAction } from "@/actions/account";
import { Button } from "@/components/ui/button";
import { pushSupport, readBrowserTraits, type PushSupport } from "@/lib/pwa/push-support";
import { currentPushSubscription, registerPushServiceWorker } from "@/lib/pwa/service-worker";

import { pushToggleView, type PushToggleView } from "./push-toggle-state";

interface PushToggleProps {
	publicKey: string | null;
}

const MESSAGES: Record<Exclude<PushToggleView, "on" | "off">, string> = {
	unavailable: "Os avisos no aparelho ainda não estão disponíveis.",
	unsupported: "Este navegador não recebe avisos no aparelho. Use o Chrome no Android ou o Safari no iPhone.",
	install_first: "No iPhone, instale o app na Tela de Início (veja abaixo) e abra por lá para ligar os avisos.",
	too_old: "Os avisos no iPhone precisam do iOS 16.4 ou mais novo. Atualize o aparelho.",
	blocked: "Os avisos estão bloqueados. Libere a permissão de notificações deste site nas configurações do navegador e volte aqui.",
};

const GENERIC_ERROR = "Não foi possível alterar os avisos. Tente de novo.";

function urlBase64ToBytes(value: string): Uint8Array<ArrayBuffer> {
	const padded = (value + "=".repeat((4 - (value.length % 4)) % 4)).replace(/-/g, "+").replace(/_/g, "/");
	const raw = atob(padded);
	return Uint8Array.from(raw, (char) => char.charCodeAt(0));
}

export function PushToggle({ publicKey }: PushToggleProps) {
	const [support, setSupport] = useState<PushSupport | null>(null);
	const [permission, setPermission] = useState<NotificationPermission>("default");
	const [browserSubscribed, setBrowserSubscribed] = useState(false);
	// null = status desconhecido (erro do servidor): não mostra "desligado".
	const [serverSubscribed, setServerSubscribed] = useState<boolean | null>(false);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const refresh = useCallback(async () => {
		const detected = pushSupport(readBrowserTraits());
		setSupport(detected);
		if (detected !== "ready") return;
		setPermission(Notification.permission);
		try {
			const subscription = await currentPushSubscription();
			setBrowserSubscribed(subscription !== null);
			if (!subscription) return setServerSubscribed(false);
			const status = await getPushSubscriptionStatusAction({ endpoint: subscription.endpoint });
			setServerSubscribed(status.error ? null : status.subscribed);
		} catch {
			setServerSubscribed(null);
		}
	}, []);

	useEffect(() => {
		void refresh();
	}, [refresh]);

	if (support === null) return <p className="text-sm text-muted-foreground">Verificando o aparelho...</p>;

	const view = pushToggleView({
		publicKeyPresent: publicKey !== null,
		support,
		permission,
		browserSubscribed,
		serverSubscribed: serverSubscribed === true,
	});

	if (view !== "on" && view !== "off") {
		return <p className="text-sm text-muted-foreground">{MESSAGES[view]}</p>;
	}
	if (serverSubscribed === null) {
		return (
			<div className="space-y-3">
				<p className="text-sm text-destructive" role="alert">Não foi possível ler o estado dos avisos.</p>
				<Button type="button" variant="outline" className="h-12" onClick={() => void refresh()}>Tentar de novo</Button>
			</div>
		);
	}

	const turnOn = async () => {
		if (!publicKey) return;
		const result = await Notification.requestPermission();
		setPermission(result);
		if (result !== "granted") return;
		const registration = await registerPushServiceWorker();
		await navigator.serviceWorker.ready;
		const subscription = await registration.pushManager.subscribe({
			userVisibleOnly: true,
			applicationServerKey: urlBase64ToBytes(publicKey),
		});
		const saved = await registerPushSubscriptionAction(subscription.toJSON());
		if (saved.error) {
			await subscription.unsubscribe();
			setError(saved.error);
			return;
		}
		setBrowserSubscribed(true);
		setServerSubscribed(true);
	};

	const turnOff = async () => {
		const subscription = await currentPushSubscription();
		if (subscription) {
			const removed = await removePushSubscriptionAction({ endpoint: subscription.endpoint });
			if (removed.error) {
				setError(removed.error);
				return;
			}
			await subscription.unsubscribe();
		}
		setBrowserSubscribed(false);
		setServerSubscribed(false);
	};

	const onClick = async () => {
		setBusy(true);
		setError(null);
		try {
			await (view === "on" ? turnOff() : turnOn());
		} catch {
			setError(GENERIC_ERROR);
		} finally {
			setBusy(false);
		}
	};

	const isOn = view === "on";
	return (
		<div className="space-y-3">
			<p className="text-sm text-muted-foreground">
				{isOn ? "Este aparelho recebe avisos de autorização, consulta pronta e comissão." : "Ligue para receber avisos neste aparelho."}
			</p>
			<Button type="button" aria-pressed={isOn} disabled={busy} onClick={() => void onClick()} className="h-12 w-full">
				{isOn ? <BellOff aria-hidden /> : <Bell aria-hidden />}
				{busy ? "Aguarde..." : isOn ? "Desligar avisos" : "Ligar avisos"}
			</Button>
			{error && <p className="text-sm text-destructive" role="alert">{error}</p>}
		</div>
	);
}
