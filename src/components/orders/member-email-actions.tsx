"use client";

import { useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";

import { resendMyMemberAuthorizationAction, updateMyMemberEmailAction } from "@/actions/orders-client";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import type { OrderMember } from "@/lib/orders/client-ops";
import type { OrderState } from "@/lib/orders/types";

interface MemberEmailActionsProps {
	dossierId: string;
	member: OrderMember;
	orderState: OrderState;
}

const PAYMENT_PENDING_MESSAGE = "E-mail salvo. O pedido de autorização sai depois do pagamento.";

// Botões "Corrigir e-mail" e "Reenviar" de uma pessoa. A tela só lê as flags; o servidor decide de novo.
export function MemberEmailActions({ dossierId, member, orderState }: MemberEmailActionsProps) {
	const router = useRouter();
	const inputRef = useRef<HTMLInputElement>(null);
	const [open, setOpen] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [success, setSuccess] = useState<string | null>(null);
	const [isPending, startTransition] = useTransition();

	if (!member.canEditEmail && !member.canResend) return null;

	const waitingPayment = orderState === "awaiting_payment";

	const run = (action: () => ReturnType<typeof resendMyMemberAuthorizationAction>, done: string, onError: (e: string) => void) => {
		setSuccess(null);
		startTransition(async () => {
			const result = await action();
			if (result.error) {
				onError(result.error);
				return;
			}
			setOpen(false);
			setSuccess(waitingPayment ? PAYMENT_PENDING_MESSAGE : done);
			router.refresh();
		});
	};

	const refs = { dossierId, consultationId: member.consultationId };

	const resend = () => {
		setError(null);
		run(() => resendMyMemberAuthorizationAction(refs), "Pedido enviado. O e-mail chega em instantes.", setError);
	};

	const submit = (e: React.FormEvent) => {
		e.preventDefault();
		setError(null);
		run(
			() => updateMyMemberEmailAction({ ...refs, email: inputRef.current?.value.trim() ?? "" }),
			"E-mail corrigido. Enviamos um novo link.",
			setError,
		);
	};

	const openForm = () => {
		setError(null);
		setSuccess(null);
		setOpen(true);
	};

	return (
		<div className="space-y-2">
			<div className="flex flex-wrap gap-2">
				{member.canEditEmail && (
					<Button type="button" variant="outline" className="min-h-11" onClick={openForm} disabled={isPending}>
						Corrigir e-mail
					</Button>
				)}
				{member.canResend && (
					<Button
						type="button"
						variant="outline"
						className="min-h-11"
						onClick={resend}
						disabled={isPending}
					>
						{isPending && !open ? "Enviando..." : "Reenviar"}
					</Button>
				)}
			</div>
			<p aria-live="polite" className="text-sm font-bold text-foreground empty:hidden">
				{success}
			</p>
			{!open && error && (
				<p role="alert" className="text-sm font-bold text-destructive">
					{error}
				</p>
			)}
			<Dialog open={open} onClose={() => setOpen(false)} title="Corrigir e-mail" dismissible={!isPending}>
				<form onSubmit={submit} noValidate className="space-y-4">
					<p className="text-base text-muted-foreground">O link enviado ao e-mail antigo deixa de funcionar.</p>
					<Field id={`email-${member.consultationId}`} label="Novo e-mail" error={error}>
						{(a11y) => (
							<Input
								{...a11y}
								ref={inputRef}
								type="email"
								autoComplete="off"
								defaultValue=""
								required
								autoFocus
								disabled={isPending}
								className="min-h-11"
							/>
						)}
					</Field>
					<div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
						<Button type="button" variant="outline" className="min-h-11" onClick={() => setOpen(false)} disabled={isPending}>
							Cancelar
						</Button>
						<Button type="submit" className="min-h-11" disabled={isPending}>
							{isPending ? "Enviando..." : "Salvar e reenviar"}
						</Button>
					</div>
				</form>
			</Dialog>
		</div>
	);
}
