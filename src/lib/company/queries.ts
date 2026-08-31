import { withUserTransaction, type DbIdentity } from "@/lib/db/transaction";
import type { EntityKind } from "@/types/app";
import type { CanonicalBureauResult } from "@/types/bureau";

export async function refreshCompanyBatchCounters(identity: DbIdentity, batchId: string): Promise<void> {
  await withUserTransaction(identity, async (client) => {
    await client.query(
      `update batches b set success_items=s.completed,error_items=s.errors,processed_items=s.completed+s.errors,
       status=case when s.errors>0 then 'completed_with_errors' when s.completed>=b.total_items then 'completed' else 'processing' end,
       completed_at=case when s.completed+s.errors>=b.total_items then now() else null end
       from (select count(*) filter(where status='completed')::int completed,count(*) filter(where status in ('error','payload_incompatible'))::int errors from consultations where batch_id=$1) s where b.id=$1`, [batchId]);
  });
}

export async function createCompanyBatch(identity: DbIdentity, input: { cnpj: string; name: string | null; product: string; members: { type: EntityKind; document: string; documentName: string; email: string | null }[]; scrMode: "internal" | "deps" }) {
  return withUserTransaction(identity, async (client) => {
    const batch = await client.query<{ id: string }>(`insert into batches (type,document,name,product,created_by,status,total_items,started_at) values ('PJ',$1,$2,$3,$4,'processing',$5,now()) returning id`, [input.cnpj,input.name,input.product,identity.userId,input.members.length]);
    const ids: string[] = [];
    for (const member of input.members) {
      const found = await client.query<{ id: string }>(`select id from crm_clients where document=$1 limit 1`, [member.document]);
      const clientId = found.rows[0]?.id ?? (await client.query<{ id: string }>(`insert into crm_clients (type,name,document,email,status,created_by,assigned_to) values ($1,$2,$3,$4,'prospect',$5,$5) returning id`, [member.type,member.documentName,member.document,member.email,identity.userId])).rows[0].id;
      await client.query(`insert into crm_client_documents (client_id,type,document,label,is_primary) values ($1,$2,$3,$4,true) on conflict do nothing`, [clientId,member.type,member.document,member.type === "PJ" ? "CNPJ" : "CPF"]);
      const inserted = await client.query<{ id: string }>(`insert into consultations (type,document,document_name,product,batch_id,crm_client_id,created_by,status,requires_auth,scr_email,scr_mode) values ($1,$2,$3,$4,$5,$6,$7,'processing',true,$8,$9) returning id`, [member.type,member.document,member.documentName,member.type === "PJ" ? input.product : "Smart PF",batch.rows[0].id,clientId,identity.userId,member.email,input.scrMode]);
      ids.push(inserted.rows[0].id);
    }
    return { batchId: batch.rows[0].id, memberQueryIds: ids };
  });
}

export async function getCompanyMember(identity: DbIdentity, id: string) {
  return withUserTransaction(identity, async (client) => (await client.query<{ id:string; type:EntityKind; document:string; document_name:string|null; status:string; batch_id:string|null; scr_email:string|null; scr_mode:"internal"|"deps"; crm_client_id:string|null }>(`select id,type,document,document_name,status::text,batch_id,scr_email,scr_mode,crm_client_id from consultations where id=$1`, [id])).rows[0] ?? null);
}

export async function companyCanonicalResults(identity: DbIdentity, batchId: string) {
  return withUserTransaction(identity, async (client) => (await client.query<{ type: EntityKind; canonical_result: CanonicalBureauResult }>(`select c.type,r.canonical_result from consultations c join bureau_results r on r.consultation_id=c.id where c.batch_id=$1 and c.status='completed' order by c.created_at`, [batchId])).rows);
}
