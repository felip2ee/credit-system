// Geração do parecer de crédito via OpenAI.
// SOMENTE server-side (Server Actions / Route Handlers) — lê a OPENAI_API_KEY.

import OpenAI from "openai";

import { ParecerSchema, type Parecer } from "@/types/ai";
import {
  COMPANY_SYSTEM_PROMPT,
  OPENAI_MODEL,
  SYSTEM_PROMPT,
  buildCompanyPayload,
  buildUserPayload,
  type CompanyParecerInput,
  type ParecerInput,
} from "./prompt";

let cached: OpenAI | null = null;

function getClient(): OpenAI {
  if (cached) return cached;
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error("OPENAI_API_KEY não configurada.");
  }
  cached = new OpenAI({ apiKey });
  return cached;
}

// Modelos de raciocínio (família o*, gpt-5) não aceitam temperature != 1.
function supportsTemperature(model: string): boolean {
  return /^gpt-(3|4)/i.test(model);
}

export interface GenerateParecerResult {
  parecer: Parecer;
  model: string;
}

// Núcleo compartilhado: chama o modelo com um system prompt + payload e valida
// a resposta contra o ParecerSchema. Usado tanto pelo parecer individual quanto
// pelo consolidado (mesmo formato de saída).
async function runParecer(
  systemPrompt: string,
  userPayload: string
): Promise<GenerateParecerResult> {
  const client = getClient();
  const model = OPENAI_MODEL;

  const params: OpenAI.Chat.ChatCompletionCreateParamsNonStreaming = {
    model,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPayload },
    ],
    response_format: { type: "json_object" },
    max_completion_tokens: 8000,
  };
  if (supportsTemperature(model)) {
    params.temperature = 0.2;
  }

  const completion = await client.chat.completions.create(params);
  const content = completion.choices[0]?.message?.content;
  if (!content) {
    throw new Error("A IA não retornou conteúdo.");
  }

  let raw: unknown;
  try {
    raw = JSON.parse(content);
  } catch {
    throw new Error("A IA retornou um JSON inválido.");
  }

  const parsed = ParecerSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(
      `O parecer veio fora do formato esperado: ${parsed.error.issues
        .map((i) => i.path.join("."))
        .join(", ")}`
    );
  }

  return { parecer: parsed.data, model };
}

// `systemPrompt` permite injetar o prompt editado pelo admin (tabela settings);
// quando omitido, usa o default em código.
export async function generateParecer(
  input: ParecerInput,
  systemPrompt: string = SYSTEM_PROMPT
): Promise<GenerateParecerResult> {
  return runParecer(systemPrompt, buildUserPayload(input));
}

// Parecer técnico consolidado do grupo (empresa + sócios do quadro societário).
export async function generateCompanyParecer(
  input: CompanyParecerInput,
  systemPrompt: string = COMPANY_SYSTEM_PROMPT
): Promise<GenerateParecerResult> {
  return runParecer(systemPrompt, buildCompanyPayload(input));
}
