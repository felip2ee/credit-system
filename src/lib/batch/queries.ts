import { withUserTransaction, type DbIdentity } from "@/lib/db/transaction";
import type { EntityKind, QueryStatus } from "@/types/app";
import type { Parecer } from "@/types/ai";

export interface BatchListItem {
  id: string;
  document: string | null;
  name: string | null;
  status: string;
  total_items: number;
  success_items: number;
  created_at: string;
}

export interface BatchMember {
  id: string;
  type: EntityKind;
  document: string;
  document_name: string | null;
  product: string | null;
  status: QueryStatus;
  consulted_at: string | null;
  created_at: string;
}

export interface CompanyReport {
  status: string;
  aptitude_status: string;
  generation_error: string | null;
  report_markdown: string | null;
  full_report: Parecer | null;
  model_used: string | null;
  generated_at: string | null;
}

export interface BatchDetail {
  batch: BatchListItem;
  members: BatchMember[];
  report: CompanyReport | null;
}

export async function listBatches(identity: DbIdentity): Promise<BatchListItem[]> {
  return withUserTransaction(identity, async (client) => {
    const { rows } = await client.query<BatchListItem>(
      `select id, document, name, status::text, total_items, success_items, created_at::text
         from batches order by created_at desc limit 100`,
    );
    return rows;
  });
}

export async function getBatchDetail(identity: DbIdentity, id: string): Promise<BatchDetail | null> {
  return withUserTransaction(identity, async (client) => {
    const batch = await client.query<BatchListItem>(
      `select id, document, name, status::text, total_items, success_items, created_at::text
         from batches where id = $1`,
      [id],
    );
    if (!batch.rows[0]) return null;
    const [members, report] = await Promise.all([
      client.query<BatchMember>(
        `select id, type, document, document_name, product, status::text, consulted_at::text, created_at::text
           from consultations where batch_id = $1 order by type, created_at`,
        [id],
      ),
      client.query<CompanyReport>(
        `select status, aptitude_status, generation_error, report_markdown, full_report, model_used, generated_at::text
           from company_reports where batch_id = $1`,
        [id],
      ),
    ]);
    return { batch: batch.rows[0], members: members.rows, report: report.rows[0] ?? null };
  });
}

export async function getBatchPdfDetail(identity: DbIdentity, id: string): Promise<BatchDetail | null> {
  return withUserTransaction(identity, async (client) => {
    const batch = await client.query<BatchListItem>(
      `select id, document, name, status::text, total_items, success_items, created_at::text
         from batches where id = $1`,
      [id],
    );
    if (!batch.rows[0]) return null;
    const [members, report] = await Promise.all([
      client.query<BatchMember>(
        `select id, type, document, document_name, product, status::text, consulted_at::text, created_at::text
           from consultations where batch_id = $1 and status = 'completed' order by created_at`,
        [id],
      ),
      client.query<CompanyReport>(
        `select status, aptitude_status, generation_error, report_markdown, full_report, model_used, generated_at::text
           from company_reports where batch_id = $1`,
        [id],
      ),
    ]);
    return { batch: batch.rows[0], members: members.rows, report: report.rows[0] ?? null };
  });
}
