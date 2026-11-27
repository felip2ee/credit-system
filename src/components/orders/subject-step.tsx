import type { UseFormReturn } from "react-hook-form";

import type { OrderFormValues } from "@/components/orders/order-wizard-steps";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";

interface SubjectStepProps {
	form: UseFormReturn<OrderFormValues>;
	isSelf: boolean;
	isEmpresarial: boolean;
	selfDocumentMasked: string | null;
}

// Etapa "Dados": quem será pesquisado. No pedido sobre a própria pessoa não há campo, só o aviso.
export function SubjectStep({ form, isSelf, isEmpresarial, selfDocumentMasked }: SubjectStepProps) {
	const {
		register,
		formState: { errors },
	} = form;

	if (isSelf) {
		return (
			<p className="text-base text-muted-foreground">
				{selfDocumentMasked !== null
					? `A pesquisa é sobre você (${selfDocumentMasked}). Quem ainda não tem autorização válida nem um pedido em aberto recebe um pedido por e-mail.`
					: "A pesquisa é sobre você. Quem ainda não tem autorização válida nem um pedido em aberto recebe um pedido por e-mail."}
			</p>
		);
	}

	return (
		<div className="space-y-4">
			<p className="text-base text-muted-foreground">
				Quem ainda não tem autorização válida nem um pedido em aberto recebe um pedido por e-mail. A consulta só roda depois da autorização de todas as pessoas pesquisadas.
			</p>
			<Field id="subject-document" label={isEmpresarial ? "CNPJ da empresa" : "CPF do responsável"} error={errors.subject?.document?.message}>
				{(a11y) => <Input {...a11y} inputMode="numeric" autoComplete="off" {...register("subject.document")} />}
			</Field>
			<Field id="subject-name" label={isEmpresarial ? "Razão social" : "Nome do responsável"} error={errors.subject?.name?.message}>
				{(a11y) => <Input {...a11y} autoComplete="off" {...register("subject.name")} />}
			</Field>
			<Field id="contact-email" label="E-mail do responsável" error={errors.contactEmail?.message}>
				{(a11y) => <Input {...a11y} type="email" autoComplete="off" {...register("contactEmail")} />}
			</Field>
		</div>
	);
}
