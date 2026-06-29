import { Circle } from "lucide-react";

import { formatDate } from "@/lib/utils";
import type { TimelineEvent } from "@/types/app";

export function ClientTimeline({ events }: { events: TimelineEvent[] }) {
  if (events.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        Sem eventos registrados ainda.
      </p>
    );
  }

  return (
    <ol className="relative space-y-4 border-l pl-6">
      {events.map((event) => (
        <li key={event.id} className="relative">
          <Circle className="absolute -left-[31px] top-1 h-3 w-3 fill-primary text-primary" />
          <div className="flex items-baseline justify-between gap-2">
            <p className="text-sm font-medium">{event.title}</p>
            <time className="shrink-0 text-xs text-muted-foreground">
              {formatDate(event.created_at)}
            </time>
          </div>
          {event.description && (
            <p className="mt-0.5 text-sm text-muted-foreground">
              {event.description}
            </p>
          )}
        </li>
      ))}
    </ol>
  );
}
