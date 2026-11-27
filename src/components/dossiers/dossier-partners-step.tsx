import { useEffect, useRef, useState } from "react";
import { useFieldArray, type UseFormReturn } from "react-hook-form";
import { Plus, Trash2 } from "lucide-react";

import type { CounterOrderFormValues } from "@/components/dossiers/dossier-holder-step";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { formatCurrency } from "@/lib/utils";
import { MAX_PARTNERS } from "@/lib/validators/order";

interface DossierPartnersStepProps {
	form: UseFormReturn<CounterOrderFormValues>;
	pricePerPartner: number;
}

// Etapa "Sócios" (só no Dossiê Empresarial). Opcional: sem sócio, o pedido é só da empresa.
export function DossierPartnersStep({ form, pricePerPartner }: DossierPartnersStepProps) {
	const {
		register,
		control,
		formState: { errors },
	} = form;
	const { fields, append, remove } = useFieldArray({ control, name: "partners" });
	const atLimit = fields.length >= MAX_PARTNERS;
	const addRef = useRef<HTMLButtonElement>(null);
	const [focusIndex, setFocusIndex] = useState<number | null>(null);

	// O botão "Remover" some com a linha: o foco vai para a linha seguinte (ou a anterior) e, sem linhas, para "Adicionar sócio".
	useEffect(() => {
		if (focusIndex === null) return;
		if (fields.length === 0) addRef.current?.focus();
		else document.getElementById(`partner-doc-${Math.min(focusIndex, fields.length - 1)}`)?.focus();
		setFocusIndex(null);
	}, [focusIndex, fields.length]);

	return (
		<div className="space-y-4">
			<p className="text-base text-muted-foreground">
				Esta etapa é opcional. Cada sócio ou cônjuge custa {formatCurrency(pricePerPartner)} e autoriza a consulta pelo próprio e-mail. Digite o CPF
				completo: o bureau mascara o CPF no quadro societário.
			</p>
			{fields.map((field, i) => (
				<div key={field.id} className="space-y-3 rounded-card border border-border bg-muted p-3">
					<Field id={`partner-doc-${i}`} label={`CPF do sócio ${i + 1}`} error={errors.partners?.[i]?.document?.message}>
						{(a11y) => <Input {...a11y} inputMode="numeric" autoComplete="off" placeholder="000.000.000-00" {...register(`partners.${i}.document`)} />}
					</Field>
					<Field id={`partner-name-${i}`} label={`Nome do sócio ${i + 1}`} error={errors.partners?.[i]?.name?.message}>
						{(a11y) => <Input {...a11y} autoComplete="off" {...register(`partners.${i}.name`)} />}
					</Field>
					<Field id={`partner-email-${i}`} label={`E-mail do sócio ${i + 1}`} error={errors.partners?.[i]?.email?.message}>
						{(a11y) => <Input {...a11y} type="email" autoComplete="off" {...register(`partners.${i}.email`)} />}
					</Field>
					<Button type="button" variant="outline" className="w-full sm:w-auto" onClick={() => {
						remove(i);
						setFocusIndex(i);
					}} aria-label={`Remover sócio ${i + 1}`}>
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
			<Button
				ref={addRef}
				type="button"
				variant="outline"
				className="w-full sm:w-auto"
				disabled={atLimit}
				onClick={() => append({ document: "", name: "", email: "" })}
			>
				<Plus aria-hidden />
				Adicionar sócio
			</Button>
			<p className="text-base text-muted-foreground" aria-live="polite">
				{fields.length} de {MAX_PARTNERS} sócios.{atLimit ? " Limite atingido." : ""}
			</p>
		</div>
	);
}
