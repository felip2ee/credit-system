"use client";

import { useFormContext } from "react-hook-form";
import { Plus, Trash2, UserRound } from "lucide-react";

import type { OrderFormValues } from "@/components/orders/order-wizard-steps";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { MAX_PARTNERS } from "@/lib/validators/order";

type PartnerRow = OrderFormValues["partners"][number];

export interface PeopleStepProps {
	// Vem do useFieldArray, que fica no pai.
	fields: { id: string }[];
	onAdd: (row?: Partial<PartnerRow>) => void;
	onRemove: (index: number) => void;
	// canAddSelf(holderType) e o comprador ainda fora da lista.
	canAddSelf: boolean;
	buyer: { name: string; email: string };
	// O servidor só guarda o CPF mascarado: o comprador digita o dele.
	selfDocumentMasked: string | null;
}

const EMPTY_ROW: PartnerRow = { name: "", document: "", email: "" };

// Lista de pessoas da empresa: comprador, sócios e cônjuges, cada um com nome, CPF e e-mail próprios.
export function PeopleStep({ fields, onAdd, onRemove, canAddSelf, buyer, selfDocumentMasked }: PeopleStepProps) {
	const {
		register,
		formState: { errors },
	} = useFormContext<OrderFormValues>();
	const full = fields.length >= MAX_PARTNERS;

	return (
		<div className="space-y-4">
			<p className="text-base text-muted-foreground">
				Sócios e cônjuges entram como pessoas comuns. Cada um autoriza pelo próprio e-mail. Até {MAX_PARTNERS} pessoas.
			</p>
			{fields.map((field, i) => (
				<div key={field.id} className="space-y-3 rounded-card border border-border bg-muted p-3">
					<div className="space-y-1">
						<Label htmlFor={`partner-name-${i}`}>Nome da pessoa {i + 1}</Label>
						<Input id={`partner-name-${i}`} autoComplete="off" aria-invalid={Boolean(errors.partners?.[i]?.name)}
							aria-describedby={errors.partners?.[i]?.name ? `partner-name-${i}-error` : undefined} {...register(`partners.${i}.name`)} />
						{errors.partners?.[i]?.name && <p id={`partner-name-${i}-error`} role="alert" className="text-base text-destructive">{errors.partners[i]?.name?.message}</p>}
					</div>
					<div className="space-y-1">
						<Label htmlFor={`partner-doc-${i}`}>CPF da pessoa {i + 1}</Label>
						<Input
							id={`partner-doc-${i}`}
							inputMode="numeric"
							autoComplete="off"
							aria-invalid={Boolean(errors.partners?.[i]?.document)}
							aria-describedby={errors.partners?.[i]?.document ? `partner-document-${i}-error` : undefined}
							{...register(`partners.${i}.document`)}
						/>
						{errors.partners?.[i]?.document && <p id={`partner-document-${i}-error`} role="alert" className="text-base text-destructive">{errors.partners[i]?.document?.message}</p>}
					</div>
					<div className="space-y-1">
						<Label htmlFor={`partner-email-${i}`}>E-mail da pessoa {i + 1}</Label>
						<Input
							id={`partner-email-${i}`}
							type="email"
							autoComplete="off"
							aria-invalid={Boolean(errors.partners?.[i]?.email)}
							aria-describedby={errors.partners?.[i]?.email ? `partner-email-${i}-error` : undefined}
							{...register(`partners.${i}.email`)}
						/>
						{errors.partners?.[i]?.email && <p id={`partner-email-${i}-error`} role="alert" className="text-base text-destructive">{errors.partners[i]?.email?.message}</p>}
					</div>
					<Button type="button" variant="outline" className="w-full sm:w-auto" onClick={() => onRemove(i)} aria-label={`Remover pessoa ${i + 1}`}>
						<Trash2 aria-hidden />
						Remover
					</Button>
				</div>
			))}
			{errors.partners?.message && <p role="alert" className="text-base text-destructive">{errors.partners.message}</p>}
			{errors.partners?.root?.message && <p role="alert" className="text-base text-destructive">{errors.partners.root.message}</p>}
			{canAddSelf && !full && (
				<div className="space-y-1">
					<Button type="button" variant="outline" className="w-full sm:w-auto" onClick={() => onAdd({ ...EMPTY_ROW, name: buyer.name, email: buyer.email })}>
						<UserRound aria-hidden />
						Adicionar eu
					</Button>
					{selfDocumentMasked !== null && (
						<p className="text-base text-muted-foreground">Digite o seu CPF ({selfDocumentMasked}) na linha que for criada.</p>
					)}
				</div>
			)}
			<Button type="button" variant="outline" className="w-full sm:w-auto" disabled={full} onClick={() => onAdd(EMPTY_ROW)}>
				<Plus aria-hidden />
				Adicionar pessoa
			</Button>
		</div>
	);
}
