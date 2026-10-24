"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";

import { cancelMyOrderAction } from "@/actions/orders-client";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";

interface CancelOrderButtonProps {
	dossierId: string;
}

export function CancelOrderButton({ dossierId }: CancelOrderButtonProps) {
	const router = useRouter();
	const [open, setOpen] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [isPending, startTransition] = useTransition();

	const confirm = () => {
		setError(null);
		startTransition(async () => {
			const result = await cancelMyOrderAction(dossierId);
			if (result.error) {
				setError(result.error);
				return;
			}
			setOpen(false);
			router.refresh();
		});
	};

	return (
		<>
			<Button type="button" variant="outline" onClick={() => setOpen(true)}>
				Cancelar pedido
			</Button>
			<Dialog open={open} onClose={() => setOpen(false)} title="Cancelar pedido" role="alertdialog" dismissible={!isPending}>
				<div className="space-y-4">
					<p className="text-sm text-muted-foreground">
						O pedido é cancelado e o valor reservado volta ao seu saldo. Esta ação não pode ser desfeita.
					</p>
					{error && (
						<p role="alert" className="text-sm text-destructive">
							{error}
						</p>
					)}
					<div className="flex justify-end gap-2">
						<Button type="button" variant="outline" onClick={() => setOpen(false)} disabled={isPending}>
							Voltar
						</Button>
						<Button type="button" variant="destructive" onClick={confirm} disabled={isPending}>
							{isPending ? "Cancelando..." : "Cancelar pedido"}
						</Button>
					</div>
				</div>
			</Dialog>
		</>
	);
}
