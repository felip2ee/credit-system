"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { QUERY_STATUS_LABEL } from "@/types/app";

export function ConsultationsFilters() {
  const router = useRouter();
  const params = useSearchParams();
  const [q, setQ] = useState(params.get("q") ?? "");

  const update = (next: Record<string, string>) => {
    const sp = new URLSearchParams(params.toString());
    for (const [key, value] of Object.entries(next)) {
      if (value) sp.set(key, value);
      else sp.delete(key);
    }
    router.push(`/consultations?${sp.toString()}`);
  };

  const inputClass =
    "h-10 rounded-md border border-input bg-background px-3 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2";

  return (
    <div className="flex flex-col gap-3 lg:flex-row lg:flex-wrap lg:items-center">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          update({ q });
        }}
        className="flex flex-1 gap-2"
      >
        <Input
          placeholder="Buscar por nome ou documento..."
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
        <Button type="submit" variant="secondary">
          Buscar
        </Button>
      </form>

      <select
        className={inputClass}
        value={params.get("type") ?? ""}
        onChange={(e) => update({ type: e.target.value })}
      >
        <option value="">Todos os tipos</option>
        <option value="PF">PF</option>
        <option value="PJ">PJ</option>
      </select>

      <select
        className={inputClass}
        value={params.get("status") ?? ""}
        onChange={(e) => update({ status: e.target.value })}
      >
        <option value="">Todos os status</option>
        {Object.entries(QUERY_STATUS_LABEL).map(([value, label]) => (
          <option key={value} value={value}>
            {label}
          </option>
        ))}
      </select>

      <div className="flex items-center gap-2">
        <input
          type="date"
          className={inputClass}
          value={params.get("from") ?? ""}
          onChange={(e) => update({ from: e.target.value })}
          aria-label="De"
        />
        <span className="text-sm text-muted-foreground">até</span>
        <input
          type="date"
          className={inputClass}
          value={params.get("to") ?? ""}
          onChange={(e) => update({ to: e.target.value })}
          aria-label="Até"
        />
      </div>
    </div>
  );
}
