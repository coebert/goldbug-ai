import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Bell } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { listNotifications } from "@/lib/notifications.functions";
import { NotificationsPanel } from "@/components/notifications-panel";
import { POLL } from "@/lib/query-keys";

const CATEGORY = "pending_slices";

export function NotificationsBell({ className = "" }: { className?: string }) {
  const list = useServerFn(listNotifications);
  const q = useQuery({
    queryKey: ["notifications", CATEGORY, "unread-count"],
    queryFn: () => list({ data: { category: CATEGORY, unreadOnly: true, limit: 1 } }),
    refetchInterval: POLL.SEMI_LIVE,
    staleTime: 30_000,
  });
  const unread = q.data?.unreadCount ?? 0;

  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={unread > 0 ? `Notifications (${unread} unread)` : "Notifications"}
          className={`relative inline-flex h-10 w-10 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground ${className}`}
        >
          <Bell className="h-4 w-4" />
          {unread > 0 && (
            <span className="absolute right-1.5 top-1.5 inline-flex min-w-[16px] items-center justify-center rounded-full bg-destructive px-1 text-[9px] font-bold leading-none text-destructive-foreground ring-2 ring-card">
              {unread > 99 ? "99+" : unread}
            </span>
          )}
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-[min(92vw,380px)] p-0">
        <NotificationsPanel />
      </PopoverContent>
    </Popover>
  );
}
