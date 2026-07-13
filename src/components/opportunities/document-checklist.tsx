"use client";

import { useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Check, Download, Loader2, Upload, X } from "lucide-react";

import {
  getOpportunityDocUrl,
  recordOpportunityDocUpload,
  setOpportunityDocStatus,
} from "@/actions/opportunities";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { createClient } from "@/lib/supabase/client";
import { cn } from "@/lib/utils";
import {
  OPPORTUNITY_DOC_STATUS_LABEL,
  type OpportunityDocStatus,
  type OpportunityDocument,
} from "@/types/app";

const DOC_VARIANT: Record<
  OpportunityDocStatus,
  "muted" | "secondary" | "success" | "destructive"
> = {
  pending: "muted",
  uploaded: "secondary",
  approved: "success",
  rejected: "destructive",
};

const BUCKET = "opportunity-docs";

function DocRow({ doc }: { doc: OpportunityDocument }) {
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  const handleFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setError(null);
    setUploading(true);
    try {
      const supabase = createClient();
      const safeName = file.name.replace(/[^\w.\-]+/g, "_");
      const path = `${doc.opportunity_id}/${doc.id}-${safeName}`;
      const { error: upErr } = await supabase.storage
        .from(BUCKET)
        .upload(path, file, { upsert: true });
      if (upErr) {
        setError(upErr.message);
        return;
      }
      const res = await recordOpportunityDocUpload({
        docId: doc.id,
        opportunityId: doc.opportunity_id,
        docLabel: doc.label,
        fileName: file.name,
        filePath: path,
        fileSize: file.size,
        fileMime: file.type || "application/octet-stream",
      });
      if (res.error) {
        setError(res.error);
        return;
      }
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Falha no envio.");
    } finally {
      setUploading(false);
      if (inputRef.current) inputRef.current.value = "";
    }
  };

  const handleDownload = () => {
    if (!doc.file_path) return;
    startTransition(async () => {
      const res = await getOpportunityDocUrl(doc.file_path!);
      if (res.url) window.open(res.url, "_blank", "noopener,noreferrer");
      else setError(res.error);
    });
  };

  const review = (status: "approved" | "rejected") => {
    let reason: string | undefined;
    if (status === "rejected") {
      reason = window.prompt("Motivo da recusa (opcional):") ?? undefined;
    }
    startTransition(async () => {
      const res = await setOpportunityDocStatus(
        doc.id,
        doc.opportunity_id,
        doc.label,
        status,
        reason
      );
      if (res.error) setError(res.error);
      else router.refresh();
    });
  };

  const busy = uploading || isPending;

  return (
    <li className="flex flex-wrap items-center gap-3 py-3">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <p className="text-sm font-medium">{doc.label}</p>
          <Badge variant={DOC_VARIANT[doc.status]}>
            {OPPORTUNITY_DOC_STATUS_LABEL[doc.status]}
          </Badge>
        </div>
        {doc.file_name && (
          <p className="truncate text-xs text-muted-foreground">{doc.file_name}</p>
        )}
        {doc.status === "rejected" && doc.rejection_reason && (
          <p className="text-xs text-destructive">{doc.rejection_reason}</p>
        )}
        {error && <p className="text-xs text-destructive">{error}</p>}
      </div>

      <div className="flex items-center gap-1.5">
        <input
          ref={inputRef}
          type="file"
          className="hidden"
          onChange={handleFile}
          disabled={busy}
        />
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => inputRef.current?.click()}
          disabled={busy}
        >
          {uploading ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <Upload className="h-4 w-4" />
          )}
          {doc.file_path ? "Substituir" : "Enviar"}
        </Button>

        {doc.file_path && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={handleDownload}
            disabled={busy}
            title="Baixar"
          >
            <Download className="h-4 w-4" />
          </Button>
        )}

        {doc.file_path && doc.status !== "approved" && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => review("approved")}
            disabled={busy}
            title="Aprovar"
            className="text-emerald-600"
          >
            <Check className="h-4 w-4" />
          </Button>
        )}
        {doc.file_path && doc.status !== "rejected" && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => review("rejected")}
            disabled={busy}
            title="Recusar"
            className="text-destructive"
          >
            <X className="h-4 w-4" />
          </Button>
        )}
      </div>
    </li>
  );
}

export function DocumentChecklist({ docs }: { docs: OpportunityDocument[] }) {
  if (docs.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        Nenhum documento no checklist.
      </p>
    );
  }
  const approved = docs.filter((d) => d.status === "approved").length;
  return (
    <div>
      <p className="mb-2 text-xs text-muted-foreground">
        {approved} de {docs.length} aprovados
      </p>
      <ul className={cn("divide-y")}>
        {docs.map((doc) => (
          <DocRow key={doc.id} doc={doc} />
        ))}
      </ul>
    </div>
  );
}
