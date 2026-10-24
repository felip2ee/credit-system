"use client";

import { useEffect, useState } from "react";

import { searchHolders, type HolderPick } from "@/actions/consultations";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { formatCNPJ, formatCPF } from "@/lib/utils";

export interface Buyer {
  profileId: string;
  name: string;
}

interface BuyerPickerProps {
  value: Buyer | null;
  onChange: (buyer: Buyer | null) => void;
  disabled?: boolean;
}

const SEARCH_DELAY_MS = 300;

const fmtDoc = (h: HolderPick) => (h.type === "PJ" ? formatCNPJ(h.document) : formatCPF(h.document));

// Comprador opcional: só Titular com conta no portal. Sem comprador, a entrega fica com a equipe.
export function BuyerPicker({ value, onChange, disabled }: BuyerPickerProps) {
  const [term, setTerm] = useState("");
  const [results, setResults] = useState<HolderPick[]>([]);
  const [searching, setSearching] = useState(false);

  useEffect(() => {
    if (value || term.trim().length < 2) {
      setResults([]);
      return;
    }
    setSearching(true);
    const id = setTimeout(async () => {
      setResults(await searchHolders(term, true));
      setSearching(false);
    }, SEARCH_DELAY_MS);
    return () => clearTimeout(id);
  }, [term, value]);

  return (
    <div className="space-y-2">
      <Label htmlFor="buyer-search">Comprador (opcional)</Label>
      {value ? (
        <div className="flex items-center justify-between rounded-md border p-3 text-sm">
          <span className="font-medium">{value.name}</span>
          <Button type="button" variant="ghost" size="sm" onClick={() => onChange(null)} disabled={disabled}>
            Trocar
          </Button>
        </div>
      ) : (
        <>
          <Input
            id="buyer-search"
            placeholder="Buscar titular com conta no portal..."
            value={term}
            onChange={(e) => setTerm(e.target.value)}
            disabled={disabled}
            aria-describedby="buyer-hint"
          />
          <div aria-live="polite">
            {searching && <p className="text-sm text-muted-foreground">Buscando...</p>}
            {!searching && term.trim().length >= 2 && results.length === 0 && (
              <p className="text-sm text-muted-foreground">Nenhum titular com conta no portal encontrado.</p>
            )}
          </div>
          {results.length > 0 && (
            <ul className="max-h-56 overflow-auto rounded-md border">
              {results.map((h) => (
                <li key={h.id}>
                  <button
                    type="button"
                    onClick={() => {
                      if (!h.clientProfileId) return;
                      onChange({ profileId: h.clientProfileId, name: h.name });
                      setTerm("");
                    }}
                    className="flex w-full items-center justify-between px-3 py-2 text-left text-sm hover:bg-muted"
                  >
                    <span className="font-medium">{h.name}</span>
                    <span className="text-muted-foreground">
                      {h.type} · {fmtDoc(h)}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
          <p id="buyer-hint" className="text-sm text-muted-foreground">
            Sem comprador: a entrega fica com a equipe.
          </p>
        </>
      )}
    </div>
  );
}
