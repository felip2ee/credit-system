import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { formatCurrency } from "@/lib/utils";

export interface ResultView {
  score: {
    valor: number | null;
    risco: string | null;
    descricao: string | null;
    prob: number | null;
  };
  smart: {
    classificacao: string | null;
    aprovado: boolean | null;
    motivo: string | null;
    limiteSugerido: number | null;
  };
  restricoes: {
    pendenciasTotal: number;
    pendenciasValor: number;
    protestos: number;
    acoes: number;
  };
  positivas: string[];
  negativas: string[];
}

export function ConsultationResult({ view }: { view: ResultView }) {
  return (
    <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
      <Card>
        <CardHeader className="pb-2">
          <CardDescription>Score</CardDescription>
          <CardTitle className="text-4xl">{view.score.valor ?? "—"}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-1 text-sm">
          <p className="font-medium">{view.score.risco ?? "—"}</p>
          <p className="text-muted-foreground">{view.score.descricao}</p>
          {view.score.prob != null && (
            <p className="text-muted-foreground">
              Probabilidade de pagamento: {view.score.prob}%
            </p>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-2">
          <CardDescription>Smart</CardDescription>
          <CardTitle className="flex items-center gap-2 text-2xl">
            {view.smart.classificacao ?? "—"}
            {view.smart.aprovado != null &&
              (view.smart.aprovado ? (
                <Badge variant="success">Aprovado</Badge>
              ) : (
                <Badge variant="destructive">Reprovado</Badge>
              ))}
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-1 text-sm">
          <p className="text-muted-foreground">{view.smart.motivo}</p>
          {view.smart.limiteSugerido != null && (
            <p>
              Limite sugerido:{" "}
              <span className="font-medium">
                {formatCurrency(view.smart.limiteSugerido)}
              </span>
            </p>
          )}
        </CardContent>
      </Card>

      <Card className="lg:col-span-2">
        <CardHeader>
          <CardTitle className="text-lg">Restrições</CardTitle>
        </CardHeader>
        <CardContent className="grid grid-cols-2 gap-4 sm:grid-cols-4">
          <Metric
            label="Pendências"
            value={String(view.restricoes.pendenciasTotal)}
          />
          <Metric
            label="Valor pendências"
            value={formatCurrency(view.restricoes.pendenciasValor)}
          />
          <Metric label="Protestos" value={String(view.restricoes.protestos)} />
          <Metric
            label="Ações judiciais"
            value={String(view.restricoes.acoes)}
          />
        </CardContent>
      </Card>

      {(view.positivas.length > 0 || view.negativas.length > 0) && (
        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle className="text-lg">Fatores Smart</CardTitle>
          </CardHeader>
          <CardContent className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div>
              <p className="mb-2 text-sm font-medium text-emerald-700">
                Positivos
              </p>
              <ul className="space-y-1 text-sm text-muted-foreground">
                {view.positivas.map((p, i) => (
                  <li key={i}>• {p}</li>
                ))}
                {view.positivas.length === 0 && <li>—</li>}
              </ul>
            </div>
            <div>
              <p className="mb-2 text-sm font-medium text-destructive">
                Atenção
              </p>
              <ul className="space-y-1 text-sm text-muted-foreground">
                {view.negativas.map((n, i) => (
                  <li key={i}>• {n}</li>
                ))}
                {view.negativas.length === 0 && <li>—</li>}
              </ul>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
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
