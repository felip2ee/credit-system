"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { SearchInput } from "@/components/ui/search-input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

// Radix não aceita valor vazio.
const ALL = "todos";

export function HoldersFilters() {
  const router = useRouter();
  const params = useSearchParams();
  const [q, setQ] = useState(params.get("q") ?? "");

  const update = (next: Record<string, string>) => {
    const sp = new URLSearchParams(params.toString());
    for (const [key, value] of Object.entries(next)) {
      if (value) sp.set(key, value);
      else sp.delete(key);
    }
    router.push(`/holders?${sp.toString()}`);
  };

  const onSearch = (e: React.FormEvent) => {
    e.preventDefault();
    update({ q });
  };

  return (
    <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
      <form onSubmit={onSearch} className="flex flex-1 gap-2">
        <SearchInput
          className="flex-1"
          aria-label="Buscar por nome, CPF ou CNPJ"
          placeholder="Buscar por nome, CPF ou CNPJ..."
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
        <Button type="submit" variant="secondary">
          Buscar
        </Button>
      </form>

      <Select value={params.get("type") || ALL} onValueChange={(value) => update({ type: value === ALL ? "" : value })}>
        <SelectTrigger aria-label="Tipo de titular" className="sm:w-56">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={ALL}>Todos os tipos</SelectItem>
          <SelectItem value="PF">Pessoa Física</SelectItem>
          <SelectItem value="PJ">Pessoa Jurídica</SelectItem>
        </SelectContent>
      </Select>
    </div>
  );
}
