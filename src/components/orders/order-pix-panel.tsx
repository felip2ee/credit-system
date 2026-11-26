"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";

import { createOrderPixAction } from "@/actions/order-payment";
import { CheckoutForm } from "@/components/payments/CheckoutForm";
import { formatCents } from "@/components/payments/checkout-summary";
import { useChargePolling } from "@/components/payments/useChargePolling";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { StatusBanner } from "@/components/ui/status-banner";

import { afterPoll, type OrderPixView } from "./order-pix-view";

const MISSING_PAYER = "Preencha os dados de pagamento que faltam.";
const REFRESH_MS = 5000;

type QrCharge = {
	id: string;
	pixPayload: string;
	qrDataUrl: string;
	expiresAt: string;
	expiresLabel: string;
	priceCents: number;
	feeCents: number;
	totalCents: number;
};

type Props = {
	view: Exclude<OrderPixView, "leave">;
	dossierId: string;
	priceCents: number;
	// Gerada no servidor: o reenvio do mesmo PIX nunca cria uma segunda cobrança.
	idempotencyKey: string;
	charge: QrCharge | null;
};

export function OrderPixPanel({ view, dossierId, priceCents, idempotencyKey, charge }: Props) {
	const orderHref = `/portal/pesquisas/${dossierId}`;
	if (view === "show_qr" && charge) return <QrView charge={charge} orderHref={orderHref} />;
	if (view === "generate") return <GenerateView dossierId={dossierId} priceCents={priceCents} idempotencyKey={idempotencyKey} />;
	if (view === "in_progress") return <InProgressView />;
	if (view === "paid_not_reserved") {
		return (
			<StatusBanner
				tone="attention"
				title="Recebemos o pagamento, mas não foi possível iniciar o pedido."
				description="O valor está no seu saldo."
				action={<Links />}
			/>
		);
	}
	return (
		<StatusBanner
			tone="neutral"
			title="O PIX venceu. O pedido será cancelado."
			description="Nada foi cobrado. Faça um novo pedido."
			action={
				<Button asChild>
					<Link href="/portal/pesquisas/nova">Fazer novo pedido</Link>
				</Button>
			}
		/>
	);
}

function Links() {
	return (
		<div className="flex flex-col gap-2 sm:flex-row">
			<Button asChild variant="outline">
				<Link href="/portal/credits">Ver meu saldo</Link>
			</Button>
			<Button asChild>
				<Link href="/portal/pesquisas/nova">Fazer novo pedido</Link>
			</Button>
		</div>
	);
}

function InProgressView() {
	const router = useRouter();
	useEffect(() => {
		const timer = setInterval(() => router.refresh(), REFRESH_MS);
		return () => clearInterval(timer);
	}, [router]);
	return <StatusBanner tone="progress" title="Gerando o PIX..." description="Isso leva alguns segundos. Não feche esta tela." />;
}

type GenerateState = { phase: "working" } | { phase: "payer" } | { phase: "error"; message: string };

function GenerateView({ dossierId, priceCents, idempotencyKey }: Pick<Props, "dossierId" | "priceCents" | "idempotencyKey">) {
	const router = useRouter();
	const [state, setState] = useState<GenerateState>({ phase: "working" });
	const started = useRef(false);

	const generate = useCallback(async () => {
		setState({ phase: "working" });
		const res = await createOrderPixAction({ dossierId, idempotencyKey }).catch(() => ({
			error: "Não foi possível gerar o PIX. Tente novamente.",
		}));
		if (!res.error) {
			router.refresh();
			return;
		}
		setState(res.error === MISSING_PAYER ? { phase: "payer" } : { phase: "error", message: res.error });
	}, [dossierId, idempotencyKey, router]);

	// Uma vez na montagem: o clique em "Tentar de novo" chama de novo.
	useEffect(() => {
		if (started.current) return;
		started.current = true;
		void generate();
	}, [generate]);

	if (state.phase === "payer") {
		return (
			<Card>
				<CardContent className="p-6">
					<CheckoutForm
						scope="client"
						fixed={{ amountCents: priceCents }}
						action={(input) => createOrderPixAction({ dossierId, ...input })}
						onPix={() => router.refresh()}
						onClose={() => setState({ phase: "error", message: "O PIX não foi gerado." })}
					/>
				</CardContent>
			</Card>
		);
	}
	if (state.phase === "error") {
		return (
			<StatusBanner
				tone="attention"
				title={state.message}
				action={
					<Button type="button" onClick={() => void generate()}>
						Tentar de novo
					</Button>
				}
			/>
		);
	}
	return <StatusBanner tone="progress" title="Gerando o PIX..." description="Isso leva alguns segundos. Não feche esta tela." />;
}

function QrView({ charge, orderHref }: { charge: QrCharge; orderHref: string }) {
	const router = useRouter();
	const [copied, setCopied] = useState(false);
	const [copyError, setCopyError] = useState<string | null>(null);
	const [failed, setFailed] = useState(false);

	const polling = useChargePolling((outcome) => {
		const next = afterPoll(outcome, new Date(charge.expiresAt), new Date());
		if (next === "go_to_order") router.push(orderHref);
		else if (next === "expired") router.refresh();
		else if (next === "poll_again") polling.start(charge.id);
		else setFailed(true);
	});
	const { start } = polling;
	useEffect(() => {
		start(charge.id);
	}, [start, charge.id]);

	const copy = async () => {
		try {
			await navigator.clipboard.writeText(charge.pixPayload);
			setCopied(true);
			setCopyError(null);
		} catch {
			setCopyError("Não foi possível copiar. Selecione o código e copie manualmente.");
		}
	};

	return (
		<Card>
			<CardContent className="space-y-5 p-6">
				{/* eslint-disable-next-line @next/next/no-img-element */}
				<img src={charge.qrDataUrl} alt="QR Code do PIX" width={208} height={208} className="mx-auto size-52 rounded-card bg-white p-2" />
				<dl className="space-y-1 text-center">
					<dt className="text-muted-foreground">Valor a pagar</dt>
					<dd className="text-3xl font-bold tabular-nums">{formatCents(charge.totalCents)}</dd>
					{charge.feeCents > 0 && (
						<dd className="text-base text-muted-foreground">
							Pedido {formatCents(charge.priceCents)} + taxa do PIX {formatCents(charge.feeCents)}
						</dd>
					)}
					<dd className="text-base text-muted-foreground">Vale até {charge.expiresLabel}</dd>
				</dl>
				<div className="space-y-2">
					<Label htmlFor="order-pix-code">PIX copia e cola</Label>
					<Input id="order-pix-code" readOnly value={charge.pixPayload} onFocus={(e) => e.target.select()} />
					<Button type="button" variant="outline" className="w-full sm:w-auto" onClick={copy}>
						{copied ? "Código copiado" : "Copiar código"}
					</Button>
					{copyError && <StatusBanner tone="danger" title={copyError} />}
				</div>
				{failed ? (
					<StatusBanner
						tone="attention"
						title="O pagamento não foi confirmado."
						description="Atualize a tela. Se o PIX não aparecer, faça um novo pedido."
						action={
							<Button type="button" onClick={() => router.refresh()}>
								Atualizar
							</Button>
						}
					/>
				) : (
					<p role="status" className="text-center text-muted-foreground">
						Aguardando o pagamento. A tela atualiza sozinha.
					</p>
				)}
			</CardContent>
		</Card>
	);
}

export type { QrCharge };
