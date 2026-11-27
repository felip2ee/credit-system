import { useFieldArray, type UseFormReturn } from "react-hook-form";
import { Plus, Trash2 } from "lucide-react";

import type { OrderFormValues } from "@/components/orders/order-wizard-steps";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { formatCurrency } from "@/lib/utils";
import { MAX_PARTNERS } from "@/lib/validators/order";

interface PartnersStepProps {
	form: UseFormReturn<OrderFormValues>;
	pricePerPartner: number;
}

// Etapa "Sócios" (só no Dossiê Empresarial). Opcional: sem sócio, a pesquisa é só da empresa.
export function PartnersStep({ form, pricePerPartner }: PartnersStepProps) {
	const {
		register,
		control,
		formState: { errors },
	} = form;
	const { fields, append, remove } = useFieldArray({ control, name: "partners" });

	return (
		<div className="space-y-4">
			<p className="text-base text-muted-foreground">
				Esta etapa é opcional. Cada sócio custa {formatCurrency(pricePerPartner)} e autoriza a própria consulta. Preencha nome, CPF e e-mail de cada sócio, ou
				remova a linha.
			</p>
			{fields.map((field, i) => (
				<div key={field.id} className="space-y-3 rounded-card border border-border bg-muted p-3">
					<Field id={`partner-name-${i}`} label={`Nome do sócio ${i + 1}`} error={errors.partners?.[i]?.name?.message}>
						{(a11y) => <Input {...a11y} autoComplete="off" {...register(`partners.${i}.name`)} />}
					</Field>
					<Field id={`partner-doc-${i}`} label={`CPF do sócio ${i + 1}`} error={errors.partners?.[i]?.document?.message}>
						{(a11y) => <Input {...a11y} inputMode="numeric" autoComplete="off" {...register(`partners.${i}.document`)} />}
					</Field>
					<Field id={`partner-email-${i}`} label={`E-mail do sócio ${i + 1}`} error={errors.partners?.[i]?.email?.message}>
						{(a11y) => <Input {...a11y} type="email" autoComplete="off" {...register(`partners.${i}.email`)} />}
					</Field>
					<Button type="button" variant="outline" className="w-full sm:w-auto" onClick={() => remove(i)} aria-label={`Remover sócio ${i + 1}`}>
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
				type="button"
				variant="outline"
				className="w-full sm:w-auto"
				disabled={fields.length >= MAX_PARTNERS}
				onClick={() => append({ name: "", document: "", email: "" })}
			>
				<Plus aria-hidden />
				Adicionar sócio
			</Button>
			<p className="text-base text-muted-foreground">Até {MAX_PARTNERS} sócios.</p>
		</div>
	);
}
