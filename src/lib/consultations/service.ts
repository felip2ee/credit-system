// Consultation persistence — the ONE controlled flow that turns a raw DEPS
// response into durable evidence + an optional canonical result + a final
// consultation status, all in a single user-scoped transaction.
//
// Spec: 2026-08-29-postgres-docker-security-design.md. Rules:
//  - The raw response is ALWAYS stored (bureau_payloads) before adaptation —
//    immutable evidence, even when it carries no usable data.
//  - Success  -> bureau_results + consultation 'completed', same transaction.
//  - Real data that fails schema validation -> payload 'incompatible' +
//    JSON-path errors (no values) + consultation 'payload_incompatible'.
//    Never fabricate a bureau_results row.
//  - No recognizable identity block (DEPS "documento sem dados / SCR ainda não
//    autorizado") -> 'no_data': payload kept at 'pending', consultation status
//    left untouched so the caller routes it to the SCR-pending flow.
//  - Any DB failure after the raw insert rolls the whole thing back.
//  - Retry with the same payload hits unique (consultation_id, payload_sha256):
//    no writes, the terminal state is re-derived from the (pure) adapter.
//  - Network/provider failure BEFORE a response propagates untouched — no
//    bureau_payloads row with a fake HTTP response.

import { createHash } from "node:crypto";

import type { PoolClient } from "pg";

import { adapt } from "@/lib/deps/adapter";
import { withUserTransaction, type DbIdentity } from "@/lib/db/transaction";
import { refreshDossierStatus } from "@/lib/dossiers/queries";
import { ensureHolder, upsertPartnership } from "@/lib/holders/queries";
import type {
  AdaptResult,
  AdapterError,
  BureauEntityKind,
  CanonicalBureauResult,
} from "@/types/bureau";
import type { DepsRawConsult } from "@/types/deps";

export interface ExecuteConsultationInput {
  identity: DbIdentity;
  consultationId: string;
  entityKind: BureauEntityKind;
  // Invokes the DEPS client. A network/provider failure BEFORE a response must
  // throw (it is propagated, not persisted).
  consult: () => Promise<DepsRawConsult>;
}

export type ExecuteConsultationResult =
  | { status: "completed"; canonical: CanonicalBureauResult }
  | { status: "payload_incompatible"; errors: AdapterError[] }
  | { status: "no_data" };

const sha256Of = (s: string): string =>
  createHash("sha256").update(s, "utf8").digest("hex");

// Deterministic UTF-8 JSON serialization: object keys sorted recursively,
// `undefined` dropped exactly as JSON.stringify does. Same value in -> same
// bytes out -> same hash out, regardless of key insertion order.
export function canonicalJson(value: unknown): string {
  if (value === undefined) return "null";
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map((v) => canonicalJson(v)).join(",")}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries
    .map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`)
    .join(",")}}`;
}

export function payloadSha256(body: unknown): string {
  return sha256Of(canonicalJson(body));
}

// A DEPS 200 whose body has no recognizable subject-identity block is the
// "documento sem dados / SCR ainda não autorizado" case (old deps/map.ts
// `hasMappableResult`) — recoverable. Every other adapter failure means real
// data that did not match the canonical schema.
function isNoData(errors: AdapterError[]): boolean {
  return errors.some(
    (e) => e.code === "root_not_object" || e.code === "missing_identity",
  );
}

function terminal(result: AdaptResult): ExecuteConsultationResult {
  if (result.ok) return { status: "completed", canonical: result.value };
  return isNoData(result.errors)
    ? { status: "no_data" }
    : { status: "payload_incompatible", errors: result.errors };
}

export async function executeConsultation(
  input: ExecuteConsultationInput,
): Promise<ExecuteConsultationResult> {
  // BEFORE a response: let network/provider errors propagate untouched.
  const raw = await input.consult();

  const serialized = canonicalJson(raw.body);
  const sha256 = sha256Of(serialized);
  const ctx = {
    product: raw.product,
    httpStatus: raw.httpStatus,
    receivedAt: raw.receivedAt,
  };

  return withUserTransaction(input.identity, async (client) => {
    // Raw evidence first (validation_status defaults to 'pending'). On retry the
    // unique (consultation_id, payload_sha256) constraint makes this a no-op.
    const inserted = await client.query<{ id: string }>(
      `insert into bureau_payloads
         (bureau_id, consultation_id, provider, product, received_at, http_status, payload, payload_sha256)
       values (app_bureau_id(), $1, 'deps', $2, $3, $4, $5::jsonb, $6)
       on conflict (consultation_id, payload_sha256) do nothing
       returning id`,
      [
        input.consultationId,
        raw.product,
        raw.receivedAt,
        raw.httpStatus,
        serialized,
        sha256,
      ],
    );

    const result = adapt(raw.body, ctx);

    // Retry of an already-stored payload: no writes, re-derive the outcome.
    if (inserted.rowCount === 0) return terminal(result);
    const payloadId = inserted.rows[0].id;

    if (!result.ok) {
      if (isNoData(result.errors)) {
        // Evidence kept at 'pending'; consultation status untouched so the
        // caller can route to the SCR-pending flow.
        return { status: "no_data" };
      }
      // JSON paths only — validation_errors never carries a payload value.
      await client.query(
        `update bureau_payloads
           set validation_status = 'incompatible', validation_errors = $2::jsonb
         where id = $1`,
        [payloadId, JSON.stringify(result.errors)],
      );
      const incompatible = await client.query<{ dossier_id: string }>(
        `update consultations set status = 'payload_incompatible' where id = $1
         returning dossier_id`,
        [input.consultationId],
      );
      await refreshDossierStatus(client, incompatible.rows[0].dossier_id);
      return { status: "payload_incompatible", errors: result.errors };
    }

    const c = result.value;
    await client.query(
      `update bureau_payloads set validation_status = 'valid' where id = $1`,
      [payloadId],
    );
    await client.query(
      `insert into bureau_results
         (bureau_id, consultation_id, payload_id, adapter_version, canonical_result,
          document, person_name, score, risk_level)
       values (app_bureau_id(), $1, $2, $3, $4::jsonb, $5, $6, $7, $8)`,
      [
        input.consultationId,
        payloadId,
        result.version,
        JSON.stringify(c),
        c.document.value,
        c.subject.name,
        c.score.value,
        c.score.riskBand,
      ],
    );
    const completed = await client.query<{ dossier_id: string }>(
      `update consultations
         set status = 'completed',
             document_name = $2,
             consulted_at = coalesce($3, consulted_at),
             historico_consulta_id = coalesce($4, historico_consulta_id),
             api_version = coalesce($5, api_version)
       where id = $1
       returning dossier_id`,
      [
        input.consultationId,
        c.subject.name,
        c.provider.consultedAt,
        c.provider.consultationId,
        c.provider.apiVersion,
      ],
    );

    await refreshDossierStatus(client, completed.rows[0].dossier_id);
    if (input.entityKind === "PJ") {
      await recordPartnershipsFromDeps(client, input.identity.userId, input.consultationId, c);
    }

    return { status: "completed", canonical: c };
  });
}

const CPF_LENGTH = 11;
const CNPJ_LENGTH = 14;

// partnership.from-deps: o quadro societário da consulta PJ vira Sociedade. Sem novas consultas.
// Sócio sem documento completo (11 ou 14 dígitos) fica de fora.
async function recordPartnershipsFromDeps(
  client: PoolClient,
  actorId: string,
  consultationId: string,
  result: CanonicalBureauResult,
): Promise<void> {
  const { rows } = await client.query<{ holder_id: string }>(
    "select holder_id from consultations where id = $1",
    [consultationId],
  );
  const companyId = rows[0]?.holder_id;
  if (!companyId) return;

  for (const owner of result.companyOwnership) {
    const document = owner.document?.replace(/\D/g, "") ?? "";
    if (document.length !== CPF_LENGTH && document.length !== CNPJ_LENGTH) continue;
    const partnerId = await ensureHolder(client, actorId, {
      type: document.length === CNPJ_LENGTH ? "PJ" : "PF",
      name: owner.name?.trim() || document,
      document,
    });
    await upsertPartnership(client, actorId, {
      companyId,
      partnerId,
      percentage: owner.sharePct,
      role: owner.role,
      source: "deps",
    });
  }
}
