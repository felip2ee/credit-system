"use client";

import { LogOut } from "lucide-react";

import { signOut } from "@/actions/auth";
import { Button } from "@/components/ui/button";
import { releaseDevicePushForLogout } from "@/lib/pwa/service-worker";

const DEFAULT_CLASS = "h-14 w-full justify-start rounded-card border border-border bg-card px-4 text-destructive hover:bg-accent hover:text-destructive";

interface PortalSignOutButtonProps {
	variant?: React.ComponentProps<typeof Button>["variant"];
	className?: string;
}

// Único ponto que remove o push do aparelho ao sair. Sem JS, o formulário envia a action sem o endpoint.
export function PortalSignOutButton({ variant = "ghost", className = DEFAULT_CLASS }: PortalSignOutButtonProps) {
	const onSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
		event.preventDefault();
		const formData = new FormData();
		const endpoint = await releaseDevicePushForLogout();
		if (endpoint) formData.set("pushEndpoint", endpoint);
		await signOut(formData);
	};

	return (
		<form action={signOut} onSubmit={(event) => void onSubmit(event)}>
			<Button type="submit" variant={variant} className={className}>
				<LogOut aria-hidden />
				Sair
			</Button>
		</form>
	);
}
