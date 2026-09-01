import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import type { ConsultationView } from "@/lib/consultations/view-model";

export function ConsultationResult({ view }: { view: ConsultationView }) {
  const { subject, score } = view;
  const na = subject.isPoliticallyExposed ? "Cliente PEP" : "—";

  return (
    <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
      <Card>
        <CardHeader className="pb-2">
          <CardDescription>Score</CardDescription>
          <CardTitle className={score.value == null ? "text-xl" : "text-4xl"}>
            {score.value ?? na}
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-1 text-sm">
          <p className="font-medium">{score.riskBand ?? na}</p>
          {score.description && (
            <p className="text-muted-foreground">{score.description}</p>
          )}
          {score.paymentProbability != null && (
            <p className="text-muted-foreground">
              Probabilidade de pagamento: {score.paymentProbability}%
            </p>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-2">
          <CardDescription>
            {view.kind === "PJ" ? "Empresa" : "Pessoa"}
          </CardDescription>
          <CardTitle className="text-2xl">{subject.name}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-1 text-sm text-muted-foreground">
          {subject.tradeName && <p>{subject.tradeName}</p>}
          {subject.registrationStatus && <p>Situação: {subject.registrationStatus}</p>}
          {view.kind === "PF" && subject.age != null && <p>{subject.age} anos</p>}
          {view.kind === "PJ" && subject.mainActivity && (
            <p>CNAE: {subject.mainActivity}</p>
          )}
          {subject.location && <p>{subject.location}</p>}
          {subject.isDeceased && <p className="text-destructive">Indicação de óbito</p>}
          {subject.isPoliticallyExposed && <p>Pessoa politicamente exposta</p>}
        </CardContent>
      </Card>

      <Card className="lg:col-span-2">
        <CardHeader>
          <CardTitle className="text-lg">Restrições</CardTitle>
        </CardHeader>
        <CardContent className="grid grid-cols-2 gap-4 sm:grid-cols-4">
          <Metric label="Pendências" value={String(view.debts.total)} />
          <Metric label="Valor pendências" value={view.debts.amount} />
          <Metric label="Protestos" value={String(view.protests.total)} />
          <Metric label="Ações judiciais" value={String(view.lawsuits.total)} />
        </CardContent>
      </Card>

      {view.messages.length > 0 && (
        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle className="text-lg">Mensagens do bureau</CardTitle>
          </CardHeader>
          <CardContent>
            <ul className="space-y-1 text-sm text-muted-foreground">
              {view.messages.map((m, i) => (
                <li key={i}>• {m}</li>
              ))}
            </ul>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

export function ConsultationUnavailable({
  consultationId,
  message,
}: {
  consultationId: string;
  message: string;
}) {
  return (
    <Card>
      <CardContent className="space-y-2 p-6">
        <p className="text-sm text-muted-foreground">{message}</p>
        <p className="text-xs text-muted-foreground">
          Código da consulta: <span className="font-mono">{consultationId}</span>
        </p>
      </CardContent>
    </Card>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="text-lg font-semibold">{value}</p>
    </div>
  );
}
