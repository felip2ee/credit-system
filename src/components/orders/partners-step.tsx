import { useFieldArray, type UseFormReturn } from "react-hook-form";
import { Plus, Trash2, UserRound } from "lucide-react";

import type { OrderFormValues } from "@/components/orders/order-wizard-steps";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { formatCurrency } from "@/lib/utils";
import { MAX_PARTNERS } from "@/lib/validators/order";

interface PartnersStepProps {
	form: UseFormReturn<OrderFormValues>;
	pricePerPartner: number;
	// canAddSelf(holderType) e o comprador ainda fora da lista.
	canAddSelf: boolean;
	buyer: { name: string; email: string };
	// O servidor só guarda o CPF mascarado: o comprador digita o dele.
	selfDocumentMasked: string | null;
}

// Etapa "Pessoas da empresa" (só no Dossiê Empresarial): comprador, sócios e cônjuges. Opcional: sem ninguém, a pesquisa é só da empresa.
export function PartnersStep({ form, pricePerPartner, canAddSelf, buyer, selfDocumentMasked }: PartnersStepProps) {
	const {
		register,
		control,
		formState: { errors },
	} = form;
	const { fields, append, remove } = useFieldArray({ control, name: "partners" });
	const full = fields.length >= MAX_PARTNERS;

	return (
		<div className="space-y-4">
			<p className="text-base text-muted-foreground">
				Esta etapa é opcional. Sócios e cônjuges entram como pessoas comuns. Cada pessoa custa {formatCurrency(pricePerPartner)} e autoriza a consulta pelo próprio
				e-mail. Pessoa sem CPF completo ainda não entra no valor.
			</p>
			{fields.map((field, i) => (
				<div key={field.id} className="space-y-3 rounded-card border border-border bg-muted p-3">
					<Field id={`partner-name-${i}`} label={`Nome da pessoa ${i + 1}`} error={errors.partners?.[i]?.name?.message}>
						{(a11y) => <Input {...a11y} autoComplete="off" {...register(`partners.${i}.name`)} />}
					</Field>
					<Field id={`partner-doc-${i}`} label={`CPF da pessoa ${i + 1}`} error={errors.partners?.[i]?.document?.message}>
						{(a11y) => <Input {...a11y} inputMode="numeric" autoComplete="off" {...register(`partners.${i}.document`)} />}
					</Field>
					<Field id={`partner-email-${i}`} label={`E-mail da pessoa ${i + 1}`} error={errors.partners?.[i]?.email?.message}>
						{(a11y) => <Input {...a11y} type="email" autoComplete="off" {...register(`partners.${i}.email`)} />}
					</Field>
					<Button type="button" variant="outline" className="w-full sm:w-auto" onClick={() => remove(i)} aria-label={`Remover pessoa ${i + 1}`}>
						<Trash2 aria-hidden />
						Remover
					</Button>
				</div>
			))}
			{errors.partners?.message && (
				<p role="alert" className="text-sm font-bold text-destructive">
					{errors.partners.message}
				</p>
			)}
			{canAddSelf && !full && (
				<div className="space-y-1">
					<Button type="button" variant="outline" className="w-full sm:w-auto" onClick={() => append({ name: buyer.name, document: "", email: buyer.email })}>
						<UserRound aria-hidden />
						Adicionar eu
					</Button>
					{selfDocumentMasked !== null && (
						<p className="text-base text-muted-foreground">Digite o seu CPF ({selfDocumentMasked}) na linha que for criada.</p>
					)}
				</div>
			)}
			<Button type="button" variant="outline" className="w-full sm:w-auto" disabled={full} onClick={() => append({ name: "", document: "", email: "" })}>
				<Plus aria-hidden />
				Adicionar pessoa
			</Button>
			<p className="text-base text-muted-foreground">Até {MAX_PARTNERS} pessoas.</p>
		</div>
	);
}
