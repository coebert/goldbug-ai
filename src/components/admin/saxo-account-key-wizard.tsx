// Guided setup: pick the broker account each live portfolio should trade, from
// the list the broker itself reports for that environment, and see the audit
// trail of every key change.
//
// Free-text key entry is deliberately absent — a typed key is exactly how a
// portfolio ends up bound to an account that does not exist in its environment.

import { useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { CheckCircle2, KeyRound, RefreshCw, AlertTriangle } from "lucide-react";
import {
  discoverSaxoAccounts,
  saveSaxoAccountKey,
  listSaxoAccountKeyAudits,
  type AccountDiscovery,
} from "@/lib/saxo-account-link.functions";

function statusTone(status: string): "default" | "secondary" | "destructive" | "outline" {
  if (status === "valid" || status === "discovered") return "default";
  if (status === "unset") return "secondary";
  return "destructive";
}

function statusLabel(status: string): string {
  switch (status) {
    case "valid":
      return "Linked & valid";
    case "inactive":
      return "Account inactive";
    case "wrong_environment":
      return "Key not in this environment";
    case "unset":
      return "No account linked";
    default:
      return status;
  }
}

export function SaxoAccountKeyWizard() {
  const qc = useQueryClient();
  const discover = useServerFn(discoverSaxoAccounts);
  const save = useServerFn(saveSaxoAccountKey);
  const audits = useServerFn(listSaxoAccountKeyAudits);
  const [selected, setSelected] = useState<Record<string, string>>({});

  const discovery = useQuery({
    queryKey: ["saxo-account-discovery"],
    queryFn: () => discover(),
    staleTime: 60_000,
  });

  const auditLog = useQuery({
    queryKey: ["saxo-account-key-audits"],
    queryFn: () => audits(),
    staleTime: 30_000,
  });

  const link = useMutation({
    mutationFn: (vars: { portfolioId: string; accountKey: string }) => save({ data: vars }),
    onSuccess: (res) => {
      if (res.ok) {
        toast.success(`Linked to account ${res.masked} on ${res.env}.`);
        void qc.invalidateQueries({ queryKey: ["saxo-account-discovery"] });
        void qc.invalidateQueries({ queryKey: ["saxo-account-key-audits"] });
      } else {
        toast.error(res.reason);
      }
    },
    onError: (e: unknown) => toast.error(e instanceof Error ? e.message : "Could not save the account key."),
  });

  const rows: AccountDiscovery[] = discovery.data ?? [];

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between gap-2 space-y-0">
        <CardTitle className="flex items-center gap-2 text-base">
          <KeyRound className="h-4 w-4" />
          Broker account keys
        </CardTitle>
        <Button
          variant="outline"
          size="sm"
          onClick={() => void discovery.refetch()}
          disabled={discovery.isFetching}
        >
          <RefreshCw className={`mr-1.5 h-3.5 w-3.5 ${discovery.isFetching ? "animate-spin" : ""}`} />
          Rediscover
        </Button>
      </CardHeader>
      <CardContent className="space-y-5">
        <p className="text-xs text-muted-foreground">
          Step 1 — pick the account each live portfolio should trade. Only accounts your broker reports for
          that environment are offered, so a key from the other environment can never be saved. Step 2 — the
          change is written to the audit log below and validated again on every scheduled check.
        </p>

        {discovery.isLoading ? (
          <p className="text-sm text-muted-foreground">Asking the broker which accounts exist…</p>
        ) : rows.length === 0 ? (
          <p className="text-sm text-muted-foreground">No live portfolios to link.</p>
        ) : (
          rows.map((row) => {
            const chosen = selected[row.portfolioId] ?? row.currentKey ?? "";
            return (
              <div key={row.portfolioId} className="rounded-lg border p-3 space-y-3">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium text-sm">{row.portfolioName}</span>
                  <Badge variant="outline" className="uppercase text-[10px]">{row.env}</Badge>
                  <Badge variant={statusTone(row.currentKeyStatus)} className="text-[10px]">
                    {statusLabel(row.currentKeyStatus)}
                  </Badge>
                  <span className="ml-auto font-mono text-[11px] text-muted-foreground">
                    {row.currentKeyMasked}
                  </span>
                </div>

                {row.error ? (
                  <Alert variant="destructive">
                    <AlertTriangle className="h-4 w-4" />
                    <AlertDescription className="text-xs">{row.error}</AlertDescription>
                  </Alert>
                ) : row.accounts.length === 0 ? (
                  <p className="text-xs text-muted-foreground">
                    The broker returned no accounts for this environment.
                  </p>
                ) : (
                  <div className="space-y-1.5">
                    {row.accounts.map((acct) => {
                      const isChosen = chosen === acct.accountKey;
                      return (
                        <button
                          key={acct.accountKey}
                          type="button"
                          onClick={() =>
                            setSelected((s) => ({ ...s, [row.portfolioId]: acct.accountKey }))
                          }
                          className={`flex w-full flex-wrap items-center gap-2 rounded-md border px-3 py-2 text-left text-xs transition ${
                            isChosen ? "border-primary bg-primary/5" : "hover:bg-muted/50"
                          }`}
                        >
                          <span className="font-mono">{acct.masked}</span>
                          {acct.currency ? (
                            <Badge variant="outline" className="text-[10px]">{acct.currency}</Badge>
                          ) : null}
                          {acct.current ? (
                            <Badge variant="secondary" className="text-[10px]">Current</Badge>
                          ) : null}
                          {acct.recommended && !acct.current ? (
                            <Badge variant="secondary" className="text-[10px]">Recommended</Badge>
                          ) : null}
                          {!acct.active ? (
                            <Badge variant="destructive" className="text-[10px]">Inactive</Badge>
                          ) : null}
                          <span className="ml-auto text-muted-foreground">
                            {acct.assetTypes.slice(0, 3).join(", ") || "—"}
                          </span>
                          {isChosen ? <CheckCircle2 className="h-3.5 w-3.5 text-primary" /> : null}
                        </button>
                      );
                    })}
                    <div className="flex justify-end pt-1">
                      <Button
                        size="sm"
                        disabled={
                          !chosen ||
                          chosen === row.currentKey ||
                          (link.isPending && link.variables?.portfolioId === row.portfolioId)
                        }
                        onClick={() => link.mutate({ portfolioId: row.portfolioId, accountKey: chosen })}
                      >
                        {chosen === row.currentKey ? "Already linked" : "Save account key"}
                      </Button>
                    </div>
                  </div>
                )}
              </div>
            );
          })
        )}

        <div className="space-y-2">
          <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            Account key audit log
          </h4>
          {(auditLog.data ?? []).length === 0 ? (
            <p className="text-xs text-muted-foreground">No checks recorded yet.</p>
          ) : (
            <ul className="space-y-1.5">
              {(auditLog.data ?? []).map((a) => (
                <li key={a.id} className="rounded-md border px-3 py-2 text-xs">
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge variant={statusTone(a.status)} className="text-[10px]">{a.status}</Badge>
                    <span className="font-medium">{a.portfolioName ?? "Default key"}</span>
                    <Badge variant="outline" className="uppercase text-[10px]">{a.env}</Badge>
                    {a.changed ? (
                      <Badge variant="secondary" className="text-[10px]">
                        {a.previousStatus} → {a.status}
                      </Badge>
                    ) : null}
                    <span className="ml-auto text-muted-foreground">
                      {new Date(a.checkedAt).toLocaleString("en-GB", { timeZone: "Europe/London" })}
                    </span>
                  </div>
                  {a.message ? <p className="mt-1 text-muted-foreground">{a.message}</p> : null}
                </li>
              ))}
            </ul>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
