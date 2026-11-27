"use client";

import { ArrowDown, ArrowUp, Users } from "lucide-react";
import { useMemo, useState } from "react";

import { Card } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { toneStyle } from "@/components/ui/state-tone";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import type { ClientLossRow } from "@/lib/affiliates/split-report";
import { formatCurrency } from "@/lib/utils";

// Prejuízo em aberto: repasse que o Asaas não reverteu ou saldo negativo de afiliado. A linha ganha fundo e o texto explica.
export const hasOpenLoss = (r: ClientLossRow) => r.reversalFailedCents > 0 || r.negativeBalanceCents > 0;

const money = (cents: number) => formatCurrency(cents / 100);

export function ClientLossTable({ rows }: { rows: ClientLossRow[] }) {
	const [desc, setDesc] = useState(true);
	const sorted = useMemo(() => [...rows].sort((a, b) => (desc ? b.refundPct - a.refundPct : a.refundPct - b.refundPct)), [rows, desc]);

	if (rows.length === 0) {
		return (
			<Card>
				<EmptyState icon={Users} title="Nenhum cliente com pagamento no período" description="Os clientes aparecem quando pagam por Pix ou cartão." />
			</Card>
		);
	}
	const SortIcon = desc ? ArrowDown : ArrowUp;
	return (
		<Card>
			<Table>
				<TableHeader>
					<TableRow className="hover:bg-transparent">
						<TableHead>Cliente</TableHead>
						<TableHead className="text-right">Total pago</TableHead>
						<TableHead className="text-right">Estornos</TableHead>
						<TableHead className="text-right">Chargebacks</TableHead>
						<TableHead className="text-right" aria-sort={desc ? "descending" : "ascending"}>
							<button
								type="button"
								onClick={() => setDesc((v) => !v)}
								className="inline-flex min-h-9 items-center gap-1 rounded-full px-2 font-medium hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
							>
								% estorno
								<SortIcon aria-hidden className="size-4" />
							</button>
						</TableHead>
						<TableHead className="text-right">Comissão já paga</TableHead>
					</TableRow>
				</TableHeader>
				<TableBody>
					{sorted.map((r) => (
						<TableRow key={r.clientId} style={hasOpenLoss(r) ? { backgroundColor: toneStyle("danger").backgroundColor } : undefined}>
							<TableCell className="font-medium">{r.clientName}</TableCell>
							<TableCell className="text-right whitespace-nowrap">{money(r.totalPaidCents)}</TableCell>
							<TableCell className="text-right whitespace-nowrap">
								{r.refundCount} · {money(r.refundCents)}
							</TableCell>
							<TableCell className="text-right whitespace-nowrap">
								{r.chargebackCount} · {money(r.chargebackCents)}
							</TableCell>
							<TableCell className="text-right font-semibold">{r.refundPct.toLocaleString("pt-BR", { minimumFractionDigits: 2 })}%</TableCell>
							<TableCell className="text-right whitespace-nowrap">
								{hasOpenLoss(r) ? (
									<>
										<span className="font-semibold">{money(r.reversalFailedCents + r.negativeBalanceCents)}</span>
										<span className="block text-xs text-muted-foreground">
											Sem reversão {money(r.reversalFailedCents)} · Saldo negativo {money(r.negativeBalanceCents)}
										</span>
									</>
								) : (
									"—"
								)}
							</TableCell>
						</TableRow>
					))}
				</TableBody>
			</Table>
		</Card>
	);
}
