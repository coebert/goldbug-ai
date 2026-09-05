import { useMemo, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Link } from "@tanstack/react-router";
import { formatDistanceToNow } from "date-fns";
import { Bell, Check, CheckCheck, RefreshCw, Trash2, ShieldAlert, Settings as SettingsIcon } from "lucide-react";
import {
  listNotifications,
  markNotificationsRead,
  markNotificationsUnread,
  markAllNotificationsRead,
  deleteNotifications,
  type NotificationRow,
} from "@/lib/notifications.functions";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ScrollArea } from "@/components/ui/scroll-area";
import { POLL } from "@/lib/query-keys";

const CATEGORIES = [
  "pending_slices",
  "insider_dealing",
  "trade_opened",
  "trade_filled",
  "trade_rejected",
];

function severityTone(s: string): string {
  switch (s) {
    case "critical": return "bg-destructive text-destructive-foreground";
    case "warning": return "bg-amber-500/15 text-amber-500 border border-amber-500/40";
    default: return "bg-muted text-muted-foreground";
  }
}

function fmtWhen(iso: string): string {
  try { return formatDistanceToNow(new Date(iso), { addSuffix: true }); }
  catch { return iso; }
}

export function NotificationsPanel() {
  const list = useServerFn(listNotifications);
  const markRead = useServerFn(markNotificationsRead);
  const markUnread = useServerFn(markNotificationsUnread);
  const markAll = useServerFn(markAllNotificationsRead);
  const del = useServerFn(deleteNotifications);

  const [tab, setTab] = useState<"all" | "unread">("unread");
  const qc = useQueryClient();

  const q = useQuery({
    queryKey: ["notifications", CATEGORIES.join(","), tab],
    queryFn: () => list({ data: { categories: CATEGORIES, unreadOnly: tab === "unread", limit: 100 } }),
    refetchInterval: POLL.SEMI_LIVE,
  });

  const invalidate = () => qc.invalidateQueries({ queryKey: ["notifications"] });

  const mRead = useMutation({ mutationFn: (ids: string[]) => markRead({ data: { ids } }), onSuccess: invalidate });
  const mUnread = useMutation({ mutationFn: (ids: string[]) => markUnread({ data: { ids } }), onSuccess: invalidate });
  const mAll = useMutation({ mutationFn: () => markAll({ data: { categories: CATEGORIES } }), onSuccess: invalidate });
  const mDel = useMutation({ mutationFn: (ids: string[]) => del({ data: { ids } }), onSuccess: invalidate });

  const rows: NotificationRow[] = q.data?.rows ?? [];
  const unreadCount = q.data?.unreadCount ?? 0;
  const isBusy = mRead.isPending || mUnread.isPending || mAll.isPending || mDel.isPending;

  const empty = useMemo(() => rows.length === 0, [rows]);

  return (
    <Card className="flex min-h-0 flex-1 flex-col overflow-hidden">
      <CardHeader className="flex shrink-0 flex-col gap-2 space-y-0 px-3 sm:flex-row sm:items-center sm:justify-between sm:px-6">
        <CardTitle className="flex flex-wrap items-center gap-2 text-base min-w-0">
          <Bell className="h-4 w-4 text-primary shrink-0" />
          <span>Notifications</span>
          {unreadCount > 0 && (
            <Badge variant="destructive">{unreadCount} unread</Badge>
          )}
        </CardTitle>
        <div className="flex flex-wrap items-center gap-2 self-end sm:shrink-0 sm:self-auto">
          <Button variant="ghost" size="sm" onClick={() => q.refetch()} disabled={q.isFetching} aria-label="Refresh">
            <RefreshCw className={`h-4 w-4 ${q.isFetching ? "animate-spin" : ""}`} />
          </Button>
          <Button variant="ghost" size="sm" asChild aria-label="Notification settings">
            <Link to="/settings">
              <SettingsIcon className="h-4 w-4" />
            </Link>
          </Button>
          <Button variant="outline" size="sm" onClick={() => mAll.mutate()} disabled={unreadCount === 0 || isBusy}>
            <CheckCheck className="mr-1 h-4 w-4" /> Mark all read
          </Button>
        </div>
      </CardHeader>
      <CardContent className="flex min-h-0 flex-1 flex-col gap-3 space-y-0 px-3 pb-3 sm:px-6">
        <Tabs className="shrink-0" value={tab} onValueChange={(v) => setTab(v as "all" | "unread")}>
          <TabsList>
            <TabsTrigger value="unread">Unread{unreadCount > 0 ? ` (${unreadCount})` : ""}</TabsTrigger>
            <TabsTrigger value="all">All</TabsTrigger>
          </TabsList>
        </Tabs>

        {q.isError && (
          <div className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
            Failed to load notifications: {(q.error as Error).message}
          </div>
        )}

        {empty ? (
          <div className="rounded-md border border-dashed p-6 text-center text-sm text-muted-foreground">
            {tab === "unread" ? "No unread pending_slices alerts." : "No notifications yet."}
          </div>
        ) : (
          <ScrollArea className="min-h-0 flex-1 pr-2 [&>[data-radix-scroll-area-viewport]]:max-h-[min(60svh,420px)]">
            <ul className="space-y-2">
              {rows.map((n) => {
                const unread = n.read_at == null;
                return (
                  <li
                    key={n.id}
                    className={`rounded-md border p-3 ${unread ? "bg-primary/5 border-primary/30" : "bg-card"}`}
                  >
                    <div className="flex items-start justify-between gap-2">
                      <div className="flex-1 min-w-0">
                        <div className="flex min-w-0 flex-wrap items-center gap-2">
                          <ShieldAlert className="h-4 w-4 text-primary shrink-0" />
                          <span className="min-w-0 break-words font-medium">{n.title}</span>
                          <Badge className={severityTone(n.severity)}>{n.severity}</Badge>
                          {unread && <Badge variant="outline" className="border-primary/50 text-primary">new</Badge>}
                        </div>
                        {n.body && (
                          <p className="mt-1 text-sm text-muted-foreground break-words">{n.body}</p>
                        )}
                        <div className="mt-2 flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
                          <time dateTime={n.created_at} title={new Date(n.created_at).toLocaleString("en-GB", { timeZone: "Europe/London" })}>
                            {fmtWhen(n.created_at)}
                          </time>
                          {n.read_at && (
                            <span title={new Date(n.read_at).toLocaleString("en-GB", { timeZone: "Europe/London" })}>
                              read {fmtWhen(n.read_at)}
                            </span>
                          )}
                          {n.portfolio_id && (
                            // Take me to the thing the alert is about, not just its id.
                            <Link
                              to="/portfolio/$id"
                              params={{ id: n.portfolio_id }}
                              hash={
                                n.category === "broker_cost_coverage_trend"
                                  ? "coverage-trend"
                                  : undefined
                              }
                              className="inline-flex items-center gap-1 font-medium text-primary underline underline-offset-2 hover:opacity-80"
                            >
                              View portfolio
                              <span className="font-mono opacity-70">
                                {n.portfolio_id.slice(0, 8)}
                              </span>
                            </Link>
                          )}
                          {n.slice_id && <span className="font-mono">slice {n.slice_id.slice(0, 8)}</span>}
                        </div>
                      </div>
                      <div className="flex shrink-0 flex-col items-end gap-1">
                        {unread ? (
                          <Button variant="ghost" size="sm" disabled={isBusy}
                            onClick={() => mRead.mutate([n.id])}>
                            <Check className="mr-1 h-3 w-3" /> Read
                          </Button>
                        ) : (
                          <Button variant="ghost" size="sm" disabled={isBusy}
                            onClick={() => mUnread.mutate([n.id])}>
                            Unread
                          </Button>
                        )}
                        <Button variant="ghost" size="sm" disabled={isBusy}
                          onClick={() => mDel.mutate([n.id])}>
                          <Trash2 className="h-3 w-3" />
                        </Button>
                      </div>
                    </div>
                  </li>
                );
              })}
            </ul>
          </ScrollArea>
        )}
      </CardContent>
    </Card>
  );
}
