"use client";

import { useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Download, Loader2, Upload } from "lucide-react";

import { getPortalDocUrl, uploadPortalDocument } from "@/actions/portal";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
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

function DocRow({ doc }: { doc: OpportunityDocument }) {
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  const locked = doc.status === "approved";

  const handleFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setError(null);
    setUploading(true);
    try {
      const formData = new FormData();
      formData.append("docId", doc.id);
      formData.append("file", file);
      const res = await uploadPortalDocument(formData);
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
    startTransition(async () => {
      const res = await getPortalDocUrl(doc.id);
      if (res.url) window.open(res.url, "_blank", "noopener,noreferrer");
      else setError(res.error);
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
          <p className="truncate text-xs text-muted-foreground">
            {doc.file_name}
          </p>
        )}
        {doc.status === "rejected" && (
          <p className="text-xs text-destructive">
            {doc.rejection_reason
              ? `Recusado: ${doc.rejection_reason}. Envie novamente.`
              : "Documento recusado. Por favor, envie novamente."}
          </p>
        )}
        {error && <p className="text-xs text-destructive">{error}</p>}
      </div>

      <div className="flex items-center gap-1.5">
        {!locked && (
          <>
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
          </>
        )}

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
      </div>
    </li>
  );
}

export function PortalDocumentChecklist({
  docs,
}: {
  docs: OpportunityDocument[];
}) {
  if (docs.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        Nenhum documento solicitado por enquanto.
      </p>
    );
  }
  const done = docs.filter(
    (d) => d.status === "uploaded" || d.status === "approved"
  ).length;
  return (
    <div>
      <p className="mb-2 text-xs text-muted-foreground">
        {done} de {docs.length} enviados
      </p>
      <ul className="divide-y">
        {docs.map((doc) => (
          <DocRow key={doc.id} doc={doc} />
        ))}
      </ul>
    </div>
  );
}
