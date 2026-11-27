"use client";

import { createContext, useContext, useState, useTransition } from "react";

import { getScrSendHistory } from "@/actions/scr";
import { CHANNEL_LABEL } from "@/components/notifications/notification-logic";
import { NotificationStatusBadge } from "@/components/notifications/NotificationStatusBadge";
import { ScrStatusBadge } from "@/components/scr/scr-status-badge";
import { Dialog } from "@/components/ui/dialog";
import { TableRow } from "@/components/ui/table";
import { countSent, type ScrSendRecord } from "@/lib/scr/send-history";
import { formatDateTime } from "@/lib/utils";
import type { ScrStatus } from "@/types/app";

interface HistoryState {
  open: boolean;
  close: () => void;
  isPending: boolean;
  error: string | null;
  history: ScrSendRecord[];
}

const HistoryContext = createContext<HistoryState | null>(null);

// Linha inteira abre o histórico de envios; botões e links dentro dela (ex.: "Enviar autorização") seguem com a ação própria.
// `stacked`: versão em lista (abaixo de `md`), com o mesmo comportamento da linha de tabela.
export function ScrHistoryRow({ id, children, stacked = false }: { id: string; children: React.ReactNode; stacked?: boolean }) {
  const [open, setOpen] = useState(false);
  const [isPending, startTransition] = useTransition();
  const [history, setHistory] = useState<ScrSendRecord[]>([]);
  const [error, setError] = useState<string | null>(null);

  const show = () => {
    setOpen(true);
    setError(null);
    startTransition(async () => {
      const res = await getScrSendHistory(id);
      setError(res.error);
      setHistory(res.history);
    });
  };

  const rowProps = {
    tabIndex: 0,
    title: "Ver histórico de envios",
    onClick: (e: React.MouseEvent<HTMLElement>) => {
      if (!(e.target as HTMLElement).closest("button, a, input, dialog")) show();
    },
    onKeyDown: (e: React.KeyboardEvent<HTMLElement>) => {
      if (e.target === e.currentTarget && (e.key === "Enter" || e.key === " ")) {
        e.preventDefault();
        show();
      }
    },
  };

  return (
    <HistoryContext.Provider value={{ open, close: () => setOpen(false), isPending, error, history }}>
      {stacked ? (
        <li {...rowProps} className="cursor-pointer px-4 py-3 focus-visible:outline focus-visible:outline-2">
          {children}
        </li>
      ) : (
        <TableRow {...rowProps} className="cursor-pointer focus-visible:outline focus-visible:outline-2">
          {children}
        </TableRow>
      )}
    </HistoryContext.Provider>
  );
}

export function ScrSendHistory({ status }: { status: ScrStatus }) {
  const ctx = useContext(HistoryContext);
  if (!ctx) return <ScrStatusBadge status={status} />;
  const { open, close, isPending, error, history } = ctx;
  return (
    <>
      <ScrStatusBadge status={status} />
      <Dialog open={open} onClose={close} title="Histórico de envios" className="max-w-lg">
        {isPending ? (
          <p className="text-sm text-muted-foreground">Carregando...</p>
        ) : error ? (
          <p className="text-sm text-destructive">{error}</p>
        ) : history.length === 0 ? (
          <p className="text-sm text-muted-foreground">Nenhum envio registrado.</p>
        ) : (
          <>
            <p className="text-sm text-muted-foreground">
              {history.length} {history.length === 1 ? "registro" : "registros"}, {countSent(history)} enviado(s) ao provedor.
            </p>
            <ul className="max-h-80 space-y-3 overflow-y-auto">
              {history.map((h) => (
                <li key={h.id} className="space-y-1 rounded-md border p-3 text-sm">
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-medium">{CHANNEL_LABEL[h.channel]}: <span className="font-mono">{h.recipientMasked}</span></span>
                    <NotificationStatusBadge status={h.status} />
                  </div>
                  <p className="text-xs text-muted-foreground">
                    {h.sentAt ? `Enviado em ${formatDateTime(h.sentAt)}` : `Criado em ${formatDateTime(h.createdAt)}`}
                    {h.attempts > 0 && ` · ${h.attempts} ${h.attempts === 1 ? "tentativa" : "tentativas"}`}
                    {h.lastErrorCode && ` · erro: ${h.lastErrorCode}`}
                  </p>
                </li>
              ))}
            </ul>
          </>
        )}
        <div className="flex justify-end">
          <button type="button" className="text-sm underline" onClick={close}>Fechar</button>
        </div>
      </Dialog>
    </>
  );
}
