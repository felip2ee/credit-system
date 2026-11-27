import { Card } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { StatusBadge } from "@/components/ui/status-badge";
import type { StateTone } from "@/components/ui/state-tone";
import { toneStyle } from "@/components/ui/state-tone";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import type { SplitReportRow } from "@/lib/affiliates/split-report";
import type { BeneficiaryKind, ChargeSplitStatus } from "@/lib/affiliates/types";
import { formatCurrency, formatDateSP } from "@/lib/utils";
import { Landmark } from "lucide-react";

const STATUS: Record<ChargeSplitStatus, { tone: StateTone; label: string }> = {
	pending: { tone: "waiting", label: "Pendente" },
	done: { tone: "success", label: "Repassado" },
	refused: { tone: "attention", label: "Recusado" },
	refunded: { tone: "neutral", label: "Estornado" },
	reversal_failed: { tone: "danger", label: "Reversão falhou" },
};

const KIND: Record<BeneficiaryKind, string> = {
	partner: "Sócio",
	bureau: "Bureau",
	bureau_referrer: "Bureau indicador",
	affiliate: "Afiliado",
};

const METHOD: Record<SplitReportRow["payoutMethod"], string> = {
	asaas: "Split do Asaas",
	pix: "Saldo do afiliado",
	accrual: "A repassar",
};

// Recusado e reversão falha pedem ação do operador: a linha ganha fundo, além do selo com texto.
const ALERT_STATUSES: ReadonlySet<ChargeSplitStatus> = new Set<ChargeSplitStatus>(["refused", "reversal_failed"]);

interface SplitReportTableProps {
	rows: SplitReportRow[];
	// Visão do superadmin: mostra de qual Bureau é cada repasse.
	showBureau?: boolean;
}

export function SplitReportTable({ rows, showBureau = false }: SplitReportTableProps) {
	if (rows.length === 0) {
		return (
			<Card>
				<EmptyState icon={Landmark} title="Nenhum repasse no período" description="Os repasses aparecem quando uma cobrança paga é dividida." />
			</Card>
		);
	}
	return (
		<Card>
			<Table>
				<TableHeader>
					<TableRow className="hover:bg-transparent">
						<TableHead>Data</TableHead>
						{showBureau && <TableHead>Bureau</TableHead>}
						<TableHead>Cobrança</TableHead>
						<TableHead>Beneficiário</TableHead>
						<TableHead className="text-right">Valor</TableHead>
						<TableHead>Status</TableHead>
					</TableRow>
				</TableHeader>
				<TableBody>
					{rows.map((r) => {
						const alert = ALERT_STATUSES.has(r.status);
						return (
							<TableRow key={r.id} style={alert ? { backgroundColor: toneStyle(STATUS[r.status].tone).backgroundColor } : undefined}>
								<TableCell className="whitespace-nowrap">{formatDateSP(r.createdAt)}</TableCell>
								{showBureau && <TableCell>{r.bureauName}</TableCell>}
								<TableCell className="font-mono text-xs" title={r.pixChargeId}>
									{r.pixChargeId.slice(0, 8)}
								</TableCell>
								<TableCell>
									<span className="block font-medium">{r.beneficiaryName ?? KIND[r.beneficiaryKind]}</span>
									<span className="block text-xs text-muted-foreground">
										{KIND[r.beneficiaryKind]} · {METHOD[r.payoutMethod]}
										{r.walletMasked ? ` · ${r.walletMasked}` : ""}
									</span>
								</TableCell>
								<TableCell className="text-right whitespace-nowrap">
									{formatCurrency(r.amountCents / 100)}
									<span className="block text-xs text-muted-foreground">{Number(r.pct).toLocaleString("pt-BR")}%</span>
								</TableCell>
								<TableCell>
									<StatusBadge tone={STATUS[r.status].tone} label={STATUS[r.status].label} />
								</TableCell>
							</TableRow>
						);
					})}
				</TableBody>
			</Table>
		</Card>
	);
}
