// Push notifications card. Lets the user enable browser push notifications
// for daily portfolio summaries and send a test notification.

import { useEffect, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Bell, BellOff, Loader2, Send } from "lucide-react";
import { toast } from "sonner";
import {
  getVapidPublicKey,
  savePushSubscription,
  deletePushSubscription,
  listMyPushSubscriptions,
  sendTestPush,
} from "@/lib/push.functions";
import { POLL } from "@/lib/query-keys";

function urlBase64ToUint8Array(base64String: string): Uint8Array {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(base64);
  const output = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) output[i] = raw.charCodeAt(i);
  return output;
}

function bufferToBase64Url(buf: ArrayBuffer | null): string {
  if (!buf) return "";
  const bytes = new Uint8Array(buf);
  let bin = "";
  for (let i = 0; i < bytes.byteLength; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function PushNotificationsCard() {
  const qc = useQueryClient();
  const getKey = useServerFn(getVapidPublicKey);
  const save = useServerFn(savePushSubscription);
  const del = useServerFn(deletePushSubscription);
  const listSubs = useServerFn(listMyPushSubscriptions);
  const testPush = useServerFn(sendTestPush);

  const [supported, setSupported] = useState<boolean | null>(null);
  const [permission, setPermission] = useState<NotificationPermission>("default");
  const [busy, setBusy] = useState(false);
  const [currentEndpoint, setCurrentEndpoint] = useState<string | null>(null);

  useEffect(() => {
    const ok =
      typeof window !== "undefined" &&
      "serviceWorker" in navigator &&
      "PushManager" in window &&
      "Notification" in window;
    setSupported(ok);
    if (ok) setPermission(Notification.permission);
    if (ok) {
      navigator.serviceWorker
        .getRegistration("/sw-push.js")
        .then(async (reg) => {
          if (!reg) return;
          const sub = await reg.pushManager.getSubscription();
          setCurrentEndpoint(sub?.endpoint ?? null);
        })
        .catch(() => {});
    }
  }, []);

  const subsQ = useQuery({
    queryKey: ["push-subs"],
    queryFn: () => listSubs(),
    refetchInterval: POLL.SEMI_LIVE,
  });

  const enable = useMutation({
    mutationFn: async () => {
      if (!supported) throw new Error("Push not supported in this browser");
      const { publicKey } = await getKey();
      const reg = await navigator.serviceWorker.register("/sw-push.js");
      await navigator.serviceWorker.ready;
      const perm = await Notification.requestPermission();
      setPermission(perm);
      if (perm !== "granted") throw new Error("Notification permission denied");
      const keyBytes = urlBase64ToUint8Array(publicKey);
      const sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: keyBytes.buffer.slice(
          keyBytes.byteOffset,
          keyBytes.byteOffset + keyBytes.byteLength,
        ) as ArrayBuffer,
      });
      const json = sub.toJSON() as { endpoint: string; keys?: { p256dh?: string; auth?: string } };
      const p256dh = json.keys?.p256dh ?? bufferToBase64Url(sub.getKey("p256dh"));
      const auth = json.keys?.auth ?? bufferToBase64Url(sub.getKey("auth"));
      await save({
        data: {
          endpoint: sub.endpoint,
          p256dh,
          auth,
          userAgent: navigator.userAgent.slice(0, 480),
        },
      });
      setCurrentEndpoint(sub.endpoint);
    },
    onSuccess: () => {
      toast.success("Push notifications enabled on this device");
      qc.invalidateQueries({ queryKey: ["push-subs"] });
    },
    onError: (e) => toast.error((e as Error).message),
  });

  const disable = useMutation({
    mutationFn: async () => {
      if (!supported) return;
      const reg = await navigator.serviceWorker.getRegistration("/sw-push.js");
      const sub = reg ? await reg.pushManager.getSubscription() : null;
      if (sub) {
        await sub.unsubscribe();
        await del({ data: { endpoint: sub.endpoint } });
      }
      setCurrentEndpoint(null);
    },
    onSuccess: () => {
      toast.success("Push disabled on this device");
      qc.invalidateQueries({ queryKey: ["push-subs"] });
    },
    onError: (e) => toast.error((e as Error).message),
  });

  const test = useMutation({
    mutationFn: () => testPush(),
    onSuccess: (r) => toast.success(`Sent to ${r.sent} device(s)`),
    onError: (e) => toast.error((e as Error).message),
  });

  const enabled = !!currentEndpoint && permission === "granted";
  const total = subsQ.data?.subscriptions.length ?? 0;

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between gap-2">
          <div>
            <CardTitle className="flex items-center gap-2 text-base">
              <Bell className="h-4 w-4 text-primary" /> Daily summary push notifications
            </CardTitle>
            <CardDescription>
              Sent daily at 22:00 UTC with the day's P&amp;L and trade count per portfolio.
            </CardDescription>
          </div>
          {enabled ? (
            <Badge className="bg-emerald-600">Enabled on this device</Badge>
          ) : (
            <Badge variant="secondary">Not enabled here</Badge>
          )}
        </div>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        {supported === false && (
          <Alert variant="destructive">
            <AlertTitle>Not supported</AlertTitle>
            <AlertDescription>
              This browser doesn't support web push. On iPhone, add Aegis to your Home Screen first
              (Share → Add to Home Screen), then open it from the home-screen icon and try again.
            </AlertDescription>
          </Alert>
        )}
        {permission === "denied" && (
          <Alert variant="destructive">
            <AlertTitle>Notifications blocked</AlertTitle>
            <AlertDescription>
              Notifications are blocked in your browser settings for this site. Allow them, then
              try again.
            </AlertDescription>
          </Alert>
        )}
        <div className="flex flex-wrap items-center gap-2">
          {!enabled ? (
            <Button
              onClick={() => {
                setBusy(true);
                enable.mutate(undefined, { onSettled: () => setBusy(false) });
              }}
              disabled={!supported || busy || enable.isPending}
            >
              {enable.isPending ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : (
                <Bell className="mr-2 h-4 w-4" />
              )}
              Enable on this device
            </Button>
          ) : (
            <Button
              variant="outline"
              onClick={() => disable.mutate()}
              disabled={disable.isPending}
            >
              {disable.isPending ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : (
                <BellOff className="mr-2 h-4 w-4" />
              )}
              Disable on this device
            </Button>
          )}
          <Button
            variant="secondary"
            onClick={() => test.mutate()}
            disabled={test.isPending || total === 0}
          >
            {test.isPending ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            ) : (
              <Send className="mr-2 h-4 w-4" />
            )}
            Send test push
          </Button>
        </div>
        <p className="text-xs text-muted-foreground">
          {total} device{total === 1 ? "" : "s"} subscribed to your daily summary.
        </p>
      </CardContent>
    </Card>
  );
}
