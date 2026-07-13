"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Check } from "lucide-react";

import { updateOpportunityStatus } from "@/actions/opportunities";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";
import {
  OPPORTUNITY_PIPELINE,
  OPPORTUNITY_STATUS_LABEL,
  type OpportunityStatus,
} from "@/types/app";

interface Props {
  opportunityId: string;
  status: OpportunityStatus;
}

const ALL_STATUSES = Object.keys(
  OPPORTUNITY_STATUS_LABEL
) as OpportunityStatus[];

export function OpportunityPipeline({ opportunityId, status }: Props) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [next, setNext] = useState<OpportunityStatus>(status);
  const [approvedAmount, setApprovedAmount] = useState("");
  const [rejectionReason, setRejectionReason] = useState("");

  const currentIndex = OPPORTUNITY_PIPELINE.indexOf(status);

  const apply = (target: OpportunityStatus) => {
    setError(null);
    startTransition(async () => {
      const res = await updateOpportunityStatus(opportunityId, target, {
        approvedAmount: approvedAmount
          ? Number(approvedAmount.replace(/\./g, "").replace(",", "."))
          : null,
        rejectionReason: rejectionReason || null,
      });
      if (res.error) {
        setError(res.error);
        return;
      }
      router.refresh();
    });
  };

  return (
    <div className="space-y-4">
      {/* Stepper das etapas lineares */}
      <ol className="flex flex-wrap items-center gap-2">
        {OPPORTUNITY_PIPELINE.map((step, i) => {
          const done = currentIndex >= 0 && i < currentIndex;
          const active = step === status;
          return (
            <li key={step} className="flex items-center gap-2">
              <span
                className={cn(
                  "flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-medium",
                  active && "border-primary bg-primary text-primary-foreground",
                  done && "border-emerald-500 bg-emerald-50 text-emerald-700",
                  !active && !done && "text-muted-foreground"
                )}
              >
                {done && <Check className="h-3 w-3" />}
                {OPPORTUNITY_STATUS_LABEL[step]}
              </span>
              {i < OPPORTUNITY_PIPELINE.length - 1 && (
                <span className="h-px w-4 bg-border" />
              )}
            </li>
          );
        })}
      </ol>

      {/* Mudança de status */}
      <div className="flex flex-wrap items-end gap-3 rounded-md border p-3">
        <div className="space-y-1">
          <Label htmlFor="opp-status">Alterar status</Label>
          <select
            id="opp-status"
            value={next}
            onChange={(e) => setNext(e.target.value as OpportunityStatus)}
            disabled={isPending}
            className="h-9 rounded-md border border-input bg-background px-3 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
          >
            {ALL_STATUSES.map((s) => (
              <option key={s} value={s}>
                {OPPORTUNITY_STATUS_LABEL[s]}
              </option>
            ))}
          </select>
        </div>

        {next === "approved" && (
          <div className="space-y-1">
            <Label htmlFor="approved-amount">Valor aprovado (R$)</Label>
            <Input
              id="approved-amount"
              value={approvedAmount}
              onChange={(e) => setApprovedAmount(e.target.value)}
              placeholder="0,00"
              className="h-9 w-40"
            />
          </div>
        )}

        {next === "rejected" && (
          <div className="space-y-1">
            <Label htmlFor="rejection-reason">Motivo da recusa</Label>
            <Input
              id="rejection-reason"
              value={rejectionReason}
              onChange={(e) => setRejectionReason(e.target.value)}
              placeholder="Motivo"
              className="h-9 w-56"
            />
          </div>
        )}

        <Button
          type="button"
          onClick={() => apply(next)}
          disabled={isPending || next === status}
        >
          {isPending ? "Salvando..." : "Aplicar"}
        </Button>
      </div>

      {error && <p className="text-sm text-destructive">{error}</p>}
    </div>
  );
}
