"use client";

import { useFormContext } from "react-hook-form";

import type { OrderFormValues } from "@/components/orders/order-wizard-steps";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { OrderProductCode } from "@/lib/orders/types";

// Dados de quem vira o titular do pedido: a empresa (empresarial) ou o responsável (conta PJ).
export function SubjectStep({ productCode }: { productCode: OrderProductCode }) {
	const {
		register,
		formState: { errors },
	} = useFormContext<OrderFormValues>();
	const isEmpresarial = productCode === "dossie_empresarial";

	return (
		<div className="space-y-4">
			<p className="text-base text-muted-foreground">
				Cada pessoa informada recebe um pedido de autorização por e-mail. A consulta só roda depois da autorização de todas.
			</p>
			<div className="space-y-2">
				<Label htmlFor="subject-document">{isEmpresarial ? "CNPJ da empresa" : "CPF do responsável"}</Label>
				<Input
					id="subject-document"
					inputMode="numeric"
					autoComplete="off"
					aria-invalid={Boolean(errors.subject?.document)}
					{...register("subject.document")}
				/>
				{errors.subject?.document && <p className="text-base text-destructive">{errors.subject.document.message}</p>}
			</div>
			<div className="space-y-2">
				<Label htmlFor="subject-name">{isEmpresarial ? "Razão social" : "Nome do responsável"}</Label>
				<Input id="subject-name" autoComplete="off" aria-invalid={Boolean(errors.subject?.name)} {...register("subject.name")} />
				{errors.subject?.name && <p className="text-base text-destructive">{errors.subject.name.message}</p>}
			</div>
			<div className="space-y-2">
				<Label htmlFor="contact-email">E-mail do responsável</Label>
				<Input id="contact-email" type="email" autoComplete="off" aria-invalid={Boolean(errors.contactEmail)} {...register("contactEmail")} />
				{errors.contactEmail && <p className="text-base text-destructive">{errors.contactEmail.message}</p>}
			</div>
		</div>
	);
}
