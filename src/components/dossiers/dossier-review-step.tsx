import type { Buyer } from "@/components/dossiers/buyer-picker";
import { maskDocument } from "@/components/admin/share-link";

interface DossierReviewStepProps {
	productName: string;
	buyer: Buyer | null;
	subjectName: string;
	subjectDocument: string;
	ownResearch: boolean;
	contactEmail: string;
	contactPhone: string;
	// Sócios que o servidor cobra (CPF completo e distinto).
	partnerCount: number;
	serverError: string | null;
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
	return (
		<div>
			<dt className="text-sm text-muted-foreground">{label}</dt>
			<dd className="break-words font-medium">{children}</dd>
		</div>
	);
}

// Etapa "Revisar e abrir pedido": resumo sem documento completo (o total fica no rodapé).
export function DossierReviewStep({
	productName,
	buyer,
	subjectName,
	subjectDocument,
	ownResearch,
	contactEmail,
	contactPhone,
	partnerCount,
	serverError,
}: DossierReviewStepProps) {
	const contact = ownResearch ? "Contato da conta do cliente" : [contactEmail.trim(), contactPhone.trim()].filter(Boolean).join(" · ");
	return (
		<div className="space-y-4">
			<dl className="space-y-3">
				<Row label="Produto">{productName}</Row>
				<Row label="Comprador">{buyer ? buyer.name : "Sem comprador: a entrega fica com a equipe."}</Row>
				<Row label="Titular">{subjectName}</Row>
				<Row label="Documento">{maskDocument(subjectDocument)}</Row>
				<Row label="Contato">{contact}</Row>
				{partnerCount > 0 && <Row label="Sócios">{partnerCount}</Row>}
			</dl>
			<div aria-live="polite">
				{serverError && (
					<p role="alert" className="text-sm font-bold text-destructive">
						{serverError}
					</p>
				)}
			</div>
		</div>
	);
}
