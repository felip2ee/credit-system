// Append-only audit trail (LGPD / compliance).
//
// Written IN THE SAME transaction as the business mutation it records — the
// caller passes its `withUserTransaction` PoolClient, so an audit failure rolls
// the mutation back (and vice-versa). `audit_logs` is insert-only for runtime
// roles (see 004_rls.sql: no update/delete grant, insert requires
// `user_id = app_user_id()`).
//
// Never store credentials, full CPF/CNPJ, tokens or raw documents — `redact()`
// masks any sensitive-looking key before it reaches the row.

import { randomUUID } from "node:crypto";
import { headers } from "next/headers";
import type { PoolClient } from "pg";

export interface AuditEvent {
  // Actor — MUST be the session user id (RLS: user_id = app_user_id()).
  actorId: string;
  // Verb, e.g. "client.create", "settings.update".
  action: string;
  // Target entity type / id.
  targetTable?: string | null;
  targetId?: string | null;
  outcome?: "success" | "failure";
  // Structured context — redacted before write.
  metadata?: Record<string, unknown> | null;
}

const SENSITIVE_KEY =
  /(cpf|cnpj|document|documento|password|senha|secret|token|auth_code|authcode|hash|api[_-]?key)/i;

// Mask sensitive-looking values recursively. Strings keep at most a 2-char
// suffix so an operator can still correlate ("***05") without exposing the id.
export function redact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (SENSITIVE_KEY.test(k)) {
        out[k] =
          typeof v === "string" && v.length >= 3 ? `***${v.slice(-2)}` : "***";
      } else {
        out[k] = redact(v);
      }
    }
    return out;
  }
  return value;
}

// Request correlation id from the proxy/edge headers, else a fresh uuid.
export function requestCorrelationId(): string {
  try {
    const h = headers();
    return (
      h.get("x-request-id") ??
      h.get("x-correlation-id") ??
      h.get("x-vercel-id") ??
      randomUUID()
    );
  } catch {
    return randomUUID();
  }
}

export async function writeAuditEvent(
  client: PoolClient,
  event: AuditEvent,
): Promise<void> {
  const metadata = redact(event.metadata ?? {}) as Record<string, unknown>;
  await client.query(
    `insert into audit_logs
       (user_id, action, table_name, record_id, outcome, request_id, metadata)
     values ($1, $2, $3, $4, $5, $6, $7::jsonb)`,
    [
      event.actorId,
      event.action,
      event.targetTable ?? null,
      event.targetId ?? null,
      event.outcome ?? "success",
      requestCorrelationId(),
      JSON.stringify(metadata),
    ],
  );
}
