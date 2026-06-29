"use client";

import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";

// Estilo de renderização dos pareceres técnicos (markdown → JSX), compartilhado
// entre o parecer individual da consulta e o parecer consolidado do processo.
export const markdownComponents: Components = {
  h1: ({ children }) => (
    <h2 className="mt-6 text-lg font-semibold text-foreground">{children}</h2>
  ),
  h2: ({ children }) => (
    <h2 className="mt-6 border-b pb-1 text-base font-semibold text-foreground">
      {children}
    </h2>
  ),
  h3: ({ children }) => (
    <h3 className="mt-4 text-sm font-semibold text-foreground">{children}</h3>
  ),
  p: ({ children }) => <p className="my-2 leading-relaxed">{children}</p>,
  ul: ({ children }) => <ul className="my-2 list-disc space-y-1 pl-5">{children}</ul>,
  ol: ({ children }) => <ol className="my-2 list-decimal space-y-1 pl-5">{children}</ol>,
  strong: ({ children }) => (
    <strong className="font-semibold text-foreground">{children}</strong>
  ),
  table: ({ children }) => (
    <div className="my-3 overflow-x-auto">
      <table className="w-full border-collapse text-xs">{children}</table>
    </div>
  ),
  th: ({ children }) => (
    <th className="border bg-muted px-2 py-1 text-left font-semibold">{children}</th>
  ),
  td: ({ children }) => <td className="border px-2 py-1 align-top">{children}</td>,
};

export function MarkdownReport({ children }: { children: string }) {
  return (
    <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents}>
      {children}
    </ReactMarkdown>
  );
}
