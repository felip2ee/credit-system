import * as React from "react";
import { Search } from "lucide-react";

import { cn } from "@/lib/utils";

// Busca em pílula. Passe aria-label ou associe um <label>.
export const SearchInput = React.forwardRef<HTMLInputElement, Omit<React.InputHTMLAttributes<HTMLInputElement>, "type">>(
  ({ className, ...props }, ref) => (
    <div className={cn("relative", className)}>
      <Search aria-hidden className="pointer-events-none absolute left-4 top-1/2 size-5 admin:size-4 -translate-y-1/2 text-muted-foreground" />
      <input
        ref={ref}
        type="search"
        className="flex h-12 w-full admin:h-10 admin:text-sm rounded-full border border-input bg-muted pl-11 pr-4 text-base ring-offset-background placeholder:text-muted-foreground focus-visible:bg-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
        {...props}
      />
    </div>
  ),
);
SearchInput.displayName = "SearchInput";
