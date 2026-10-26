"use client";

import { useEffect, useState } from "react";
import { Download } from "lucide-react";

import { Button } from "@/components/ui/button";
import { isIos, readBrowserTraits } from "@/lib/pwa/push-support";

interface InstallPromptEvent extends Event {
	prompt: () => Promise<void>;
}

type Platform = "ios" | "other";

export function InstallGuide() {
	const [platform, setPlatform] = useState<Platform | null>(null);
	const [installed, setInstalled] = useState(false);
	const [promptEvent, setPromptEvent] = useState<InstallPromptEvent | null>(null);

	useEffect(() => {
		const traits = readBrowserTraits();
		setInstalled(traits.standalone);
		setPlatform(isIos(traits.userAgent, traits.maxTouchPoints) ? "ios" : "other");
		const onPrompt = (event: Event) => {
			event.preventDefault();
			setPromptEvent(event as InstallPromptEvent);
		};
		window.addEventListener("beforeinstallprompt", onPrompt);
		return () => window.removeEventListener("beforeinstallprompt", onPrompt);
	}, []);

	if (platform === null) return null;
	if (installed) return <p className="text-sm text-muted-foreground">App instalado.</p>;

	if (platform === "ios") {
		return (
			<div className="space-y-2 text-sm text-muted-foreground">
				<p>Toque em Compartilhar › Adicionar à Tela de Início.</p>
				<p>Os avisos no iPhone precisam do iOS 16.4 ou mais novo.</p>
			</div>
		);
	}

	if (promptEvent) {
		return (
			<Button type="button" variant="outline" className="h-12 w-full" onClick={() => void promptEvent.prompt()}>
				<Download aria-hidden />
				Instalar
			</Button>
		);
	}
	return <p className="text-sm text-muted-foreground">Use o menu do navegador › Instalar app.</p>;
}
