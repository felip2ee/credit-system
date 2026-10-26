"use client";

import { useState } from "react";
import { Check, Copy } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { StatusBanner } from "@/components/ui/status-banner";
import { toast } from "@/components/ui/toaster";

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
      toast({ tone: "success", title: "Link copiado." });
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setFailed(true);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-xl">Seu link de indicação</CardTitle>
      </CardHeader>
      <CardContent className="space-y-2">
        <div className="flex flex-col gap-2 sm:flex-row">
          <Input
            readOnly
            value={link}
            aria-label="Link de indicação"
            onFocus={(event) => event.currentTarget.select()}
            className="min-w-0 flex-1 bg-muted"
          />
          <Button type="button" size="lg" glow onClick={copy} aria-label="Copiar link de indicação">
            {copied ? <Check aria-hidden /> : <Copy aria-hidden />}
            {copied ? "Copiado" : "Copiar"}
          </Button>
        </div>
        {failed && <StatusBanner tone="attention" title="Não foi possível copiar." description="Selecione o link e copie." />}
      </CardContent>
    </Card>
  );
}
