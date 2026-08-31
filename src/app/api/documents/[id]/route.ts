// Authorized streaming download for private scanned documents.
//
// The metadata row is read inside a withUserTransaction so RLS decides
// visibility: a row the caller cannot see yields 404 (never 403). The object is
// opened by its stored relative key with traversal protection and streamed
// without buffering the whole file.
//
// The RLS 404 behaviour needs a real Postgres and is verified at the Task 15
// release gate.

import { Readable } from "node:stream";

import { getCurrentProfile } from "@/lib/auth";
import { withUserTransaction, type DbIdentity } from "@/lib/db/transaction";
import { SAFE_DOWNLOAD_MIMES, sanitizeDisplayName } from "@/lib/documents/service";
import { openObject } from "@/lib/documents/storage";

export async function GET(
  _request: Request,
  { params }: { params: { id: string } },
) {
  const profile = await getCurrentProfile();
  if (!profile) return new Response("Unauthorized", { status: 401 });

  const identity: DbIdentity = { userId: profile.id, role: profile.role };

  let row:
    | { object_key: string | null; file_name: string | null; detected_mime: string | null }
    | undefined;
  try {
    row = await withUserTransaction(identity, async (client) => {
      const result = await client.query(
        `select object_key, file_name, detected_mime
           from opportunity_documents
          where id = $1`,
        [params.id],
      );
      return result.rows[0];
    });
  } catch {
    return new Response("Not found", { status: 404 });
  }

  if (!row || !row.object_key) return new Response("Not found", { status: 404 });

  const mime =
    row.detected_mime && SAFE_DOWNLOAD_MIMES.has(row.detected_mime)
      ? row.detected_mime
      : "application/octet-stream";
  const filename = sanitizeDisplayName(row.file_name ?? "documento");

  let handle;
  try {
    handle = await openObject(row.object_key);
  } catch {
    return new Response("Not found", { status: 404 });
  }

  // Stream the file, closing the underlying fd when the stream ends/errors/cancels.
  const nodeStream = handle.createReadStream();
  nodeStream.on("close", () => {
    handle.close().catch(() => {});
  });

  return new Response(Readable.toWeb(nodeStream) as unknown as ReadableStream, {
    status: 200,
    headers: {
      "Content-Type": mime,
      "Content-Disposition": `attachment; filename="${filename}"`,
      "X-Content-Type-Options": "nosniff",
      "Cache-Control": "private, no-store",
    },
  });
}
