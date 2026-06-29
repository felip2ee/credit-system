"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";

import { updateClientStatus } from "@/actions/clients";
import { CRM_STATUS_LABEL, type CrmClientStatus } from "@/types/app";

export function ClientStatusSelect({
  clientId,
  status,
}: {
  clientId: string;
  status: CrmClientStatus;
}) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();

  const onChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const next = e.target.value as CrmClientStatus;
    startTransition(async () => {
      await updateClientStatus(clientId, next);
      router.refresh();
    });
  };

  return (
    <select
      value={status}
      onChange={onChange}
      disabled={isPending}
      className="h-9 rounded-md border border-input bg-background px-3 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
    >
      {Object.entries(CRM_STATUS_LABEL).map(([value, label]) => (
        <option key={value} value={value}>
          {label}
        </option>
      ))}
    </select>
  );
}
