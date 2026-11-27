import { Card } from "@/components/ui/card";
import { PayablesPanel } from "@/components/payouts/PayablesPanel";
import { DebtNote } from "@/components/wallet/DebtNote";
import { TabIntro } from "@/components/wallet/TabIntro";
import type { RequiredSession } from "@/lib/auth/session";
import type { PayableBuckets } from "@/lib/payables/queries";
import { formatDateSP } from "@/lib/utils";
import { formatMoney } from "@/lib/wallet/money";

function Bucket({ title, value, note }: { title: string; value: string; note: string }) {
  return (
    <Card className="space-y-1 p-4">
      <h2 className="text-base text-muted-foreground">{title}</h2>
      <p className="text-xl font-bold md:text-2xl leading-tight tabular-nums">{formatMoney(value)}</p>
      <p className="text-sm text-muted-foreground">{note}</p>
    </Card>
  );
}

export function PayoutsTab({
  buckets,
  retentionDays,
  session,
  bureauId,
}: {
  buckets: PayableBuckets;
  retentionDays: number;
  session: RequiredSession;
  bureauId: string;
}) {
  const retainedNote =
    buckets.nextReleaseAt && Number(buckets.retained) > 0
      ? `Próxima liberação em ${formatDateSP(buckets.nextReleaseAt)}. Cada lucro fica ${retentionDays} dias em liberação.`
      : `Cada lucro fica ${retentionDays} dias em liberação antes de poder ser sacado.`;
  return (
    <div className="space-y-4">
      <TabIntro>O lucro dos pedidos online fica em liberação e depois pode ser sacado. Aqui você vê cada valor e o histórico de repasses.</TabIntro>
      <DebtNote debt={buckets.debt} />
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Bucket title="Disponível para saque" value={buckets.released} note="Já liberado. Pode ser repassado a você agora." />
        <Bucket title="Em liberação" value={buckets.retained} note={retainedNote} />
        <Bucket title="Em repasse" value={buckets.inPayout} note="Valor de um repasse já criado, ainda não pago." />
        <Bucket title="Já repassado" value={buckets.paid} note="Total que a Rainha Cred já pagou a você." />
      </div>
      <PayablesPanel session={session} bureauId={bureauId} />
    </div>
  );
}
