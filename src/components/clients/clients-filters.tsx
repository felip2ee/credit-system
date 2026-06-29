"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { CRM_STATUS_LABEL } from "@/types/app";

export function ClientsFilters() {
  const router = useRouter();
  const params = useSearchParams();
  const [q, setQ] = useState(params.get("q") ?? "");

  const update = (next: Record<string, string>) => {
    const sp = new URLSearchParams(params.toString());
    for (const [key, value] of Object.entries(next)) {
      if (value) sp.set(key, value);
      else sp.delete(key);
    }
    router.push(`/clients?${sp.toString()}`);
  };

  const onSearch = (e: React.FormEvent) => {
    e.preventDefault();
    update({ q });
  };

  const selectClass =
    "h-10 rounded-md border border-input bg-background px-3 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2";

  return (
    <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
      <form onSubmit={onSearch} className="flex flex-1 gap-2">
        <Input
          placeholder="Buscar por nome, CPF ou CNPJ..."
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
        <Button type="submit" variant="secondary">
          Buscar
        </Button>
      </form>

      <select
        className={selectClass}
        value={params.get("type") ?? ""}
        onChange={(e) => update({ type: e.target.value })}
      >
        <option value="">Todos os tipos</option>
        <option value="PF">Pessoa Física</option>
        <option value="PJ">Pessoa Jurídica</option>
      </select>

      <select
        className={selectClass}
        value={params.get("status") ?? ""}
        onChange={(e) => update({ status: e.target.value })}
      >
        <option value="">Todos os status</option>
        {Object.entries(CRM_STATUS_LABEL).map(([value, label]) => (
          <option key={value} value={value}>
            {label}
          </option>
        ))}
      </select>
    </div>
  );
}
