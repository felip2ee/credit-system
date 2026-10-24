"use client";

import { useState } from "react";
import { Check, Copy } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

interface AffiliateLinkCardProps {
  link: string;
}

export function AffiliateLinkCard({ link }: AffiliateLinkCardProps) {
  const [copied, setCopied] = useState(false);
  const [failed, setFailed] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(link);
      setFailed(false);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setFailed(true);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-lg">Seu link de indicação</CardTitle>
      </CardHeader>
      <CardContent className="space-y-2">
        <div className="flex flex-col gap-2 sm:flex-row">
          <input
            readOnly
            value={link}
            aria-label="Link de indicação"
            onFocus={(event) => event.currentTarget.select()}
            className="h-10 min-w-0 flex-1 rounded-md border bg-muted px-3 text-sm"
          />
          <Button type="button" onClick={copy} aria-label="Copiar link de indicação">
            {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
            {copied ? "Copiado" : "Copiar"}
          </Button>
        </div>
        {failed && <p className="text-sm text-destructive">Não foi possível copiar. Selecione o link e copie.</p>}
      </CardContent>
    </Card>
  );
}
