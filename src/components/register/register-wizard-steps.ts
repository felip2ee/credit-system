// Lógica pura do cadastro em etapas: o envio continua um só; as etapas são só apresentação.
import { registerFormSchema, type RegisterFormValues } from "@/lib/validators/register";

export type RegisterStepId = "who" | "contact" | "access";
export type RegisterFieldName = keyof RegisterFormValues;

export interface RegisterStep {
	id: RegisterStepId;
	// Rótulo curto do cabeçalho ("Passo 1 de 3: Quem é você").
	label: string;
	// Título da etapa (h2).
	title: string;
	// "O que acontece depois", em linguagem simples.
	after: string;
	// Campos que a etapa valida ao continuar.
	fields: RegisterFieldName[];
}

export const REGISTER_STEPS: RegisterStep[] = [
	{
		id: "who",
		label: "Quem é você",
		title: "Quem é você",
		after: "Você informa seu e-mail e seu celular.",
		fields: ["type", "name", "document"],
	},
	{
		id: "contact",
		label: "Contato",
		title: "Contato",
		after: "Você cria a senha e aceita os termos.",
		fields: ["email", "phone"],
	},
	{
		id: "access",
		label: "Senha e termos",
		title: "Senha e termos",
		after: "Sua conta é criada e você entra direto no portal. Não precisa confirmar o e-mail.",
		fields: ["password", "confirm", "acceptedTerms"],
	},
];

// Mesmas regras do schema do envio: uma só fonte da verdade. Só contam os erros dos campos da etapa.
export function canLeaveStep(step: RegisterStepId, values: RegisterFormValues): boolean {
	const result = registerFormSchema.safeParse(values);
	if (result.success) return true;
	const fields = REGISTER_STEPS.find((s) => s.id === step)?.fields ?? [];
	return !result.error.issues.some((issue) => fields.includes(issue.path[0] as RegisterFieldName));
}

// Etapa que tem o campo; nulo para campo oculto (slug, versões, código de indicação).
export function stepOfField(field: string): RegisterStepId | null {
	return REGISTER_STEPS.find((s) => (s.fields as string[]).includes(field))?.id ?? null;
}

// Textos de registerClientAction (src/actions/register.ts). Arquivo "use server" não exporta constantes:
// a cópia é guardada por um teste que compara com o texto da action.
export const SERVER_MESSAGES = {
	emailInUse: "E-mail já cadastrado. Entre com sua senha ou recupere o acesso.",
	documentInUse: "Documento já cadastrado neste Bureau. Peça o acesso ao Bureau.",
} as const;

export interface ServerErrorTarget {
	step: RegisterStepId;
	field: "email" | "document";
}

// Resposta da action que pertence a um campo: devolve a etapa e o campo; as demais ficam no aviso.
export function serverErrorTarget(message: string): ServerErrorTarget | null {
	if (message === SERVER_MESSAGES.emailInUse) return { step: "contact", field: "email" };
	if (message === SERVER_MESSAGES.documentInUse) return { step: "who", field: "document" };
	return null;
}

// Sair da tela perde o que foi digitado: só pede confirmação se há algo a perder.
export function hasTypedData(values: RegisterFormValues): boolean {
	return (
		[values.name, values.document, values.email, values.phone, values.password, values.confirm].some((v) => v.trim() !== "") ||
		values.acceptedTerms
	);
}
