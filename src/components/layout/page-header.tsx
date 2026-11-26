interface PageHeaderProps {
  title: string;
  description?: string;
  children?: React.ReactNode;
}

export function PageHeader({ title, description, children }: PageHeaderProps) {
  return (
    <div className="mb-6 dense:mb-4 flex flex-wrap items-start justify-between gap-3 admin:mb-5">
      <div className="min-w-0">
        <h1 className="text-2xl font-bold leading-tight">{title}</h1>
        {description && (
          <p className="mt-1 text-base text-muted-foreground admin:text-sm">{description}</p>
        )}
      </div>
      {children && <div className="flex flex-wrap items-center gap-2">{children}</div>}
    </div>
  );
}
