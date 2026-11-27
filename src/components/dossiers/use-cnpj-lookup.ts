import { useEffect, useRef, useState, useTransition } from "react";
import type { UseFormReturn } from "react-hook-form";

import { lookupCnpj } from "@/actions/holders";
import type { CounterOrderFormValues } from "@/components/dossiers/dossier-holder-step";

export interface CnpjLookup {
	run: () => void;
	pending: boolean;
	message: string | null;
}

// "Consultar CNPJ" do titular. `active` é falso fora da etapa Titular: um resultado que chega depois da saída é ignorado.
export function useCnpjLookup(form: UseFormReturn<CounterOrderFormValues>, active: boolean): CnpjLookup {
	const [pending, startLookup] = useTransition();
	const [message, setMessage] = useState<string | null>(null);
	const activeRef = useRef(active);
	useEffect(() => {
		activeRef.current = active;
	}, [active]);

	const run = () => {
		setMessage(null);
		startLookup(async () => {
			const result = await lookupCnpj(form.getValues("subject.document"));
			if (!activeRef.current) return;
			if (result.error || !result.data) {
				setMessage(result.error ?? "Falha na consulta.");
				return;
			}
			form.setValue("subject.name", result.data.name, { shouldValidate: true });
			if (result.data.email && !form.getValues("contactEmail")) form.setValue("contactEmail", result.data.email);
			setMessage(`Dados carregados${result.data.situacao ? ` — ${result.data.situacao}` : ""}.`);
		});
	};

	return { run, pending, message };
}
