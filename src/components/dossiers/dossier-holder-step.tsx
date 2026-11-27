import type { UseFormReturn } from "react-hook-form";
import type { z } from "zod";

import { Button } from "@/components/ui/button";
import type { CnpjLookup } from "@/components/dossiers/use-cnpj-lookup";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import type { counterOrderSchema } from "@/lib/validators/order";

export type CounterOrderFormValues = z.input<typeof counterOrderSchema>;

interface DossierHolderStepProps {
	form: UseFormReturn<CounterOrderFormValues>;
	isPf: boolean;
	ownResearch: boolean;
	lookup: CnpjLookup;
}

// Etapa "Titular". Na pesquisa do próprio comprador os dados de contato vêm da conta do cliente.
export function DossierHolderStep({ form, isPf, ownResearch, lookup }: DossierHolderStepProps) {
	const {
		register,
		formState: { errors },
	} = form;

	return (
		<div className="space-y-4">
			<p className="text-base text-muted-foreground">
				Titular: {isPf ? "pessoa física" : "empresa"}. Ele recebe o pedido de autorização para consultar o SCR por e-mail e celular.
			</p>
			<Field
				id="subject-document"
				label={isPf ? "CPF" : "CNPJ"}
				error={errors.subject?.document?.message}
				helper={lookup.message ?? undefined}
			>
				{(a11y) => (
					<div className="flex gap-2">
						<Input
							{...a11y}
							inputMode="numeric"
							autoComplete="off"
							placeholder={isPf ? "000.000.000-00" : "00.000.000/0000-00"}
							{...register("subject.document")}
						/>
						{!isPf && (
							<Button type="button" variant="outline" onClick={lookup.run} disabled={lookup.pending}>
								Consultar CNPJ
							</Button>
						)}
					</div>
				)}
			</Field>
			<Field id="subject-name" label={isPf ? "Nome" : "Razão social"} error={errors.subject?.name?.message}>
				{(a11y) => <Input {...a11y} autoComplete="off" {...register("subject.name")} />}
			</Field>
			{ownResearch ? (
				<p className="text-base text-muted-foreground" aria-live="polite">
					Os dados de contato vêm da conta do cliente.
				</p>
			) : (
				<>
					<Field id="contactEmail" label="E-mail do titular" error={errors.contactEmail?.message}>
						{(a11y) => <Input {...a11y} type="email" autoComplete="off" placeholder="contato@exemplo.com" {...register("contactEmail")} />}
					</Field>
					<Field id="contactPhone" label="Celular do titular" error={errors.contactPhone?.message}>
						{(a11y) => <Input {...a11y} type="tel" autoComplete="off" placeholder="(11) 99999-9999" {...register("contactPhone")} />}
					</Field>
				</>
			)}
		</div>
	);
}
