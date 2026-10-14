import { z } from "zod";

export const uuidSchema = z.string().uuid("Identificador inválido.");

// Guarda de id de rota/ação: evita que um valor não-uuid chegue ao Postgres (erro 22P02 vira 500).
export const isUuid = (value: unknown): value is string => uuidSchema.safeParse(value).success;
