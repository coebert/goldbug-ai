// Import a downloaded broker booking statement so fees on the fill tape become
// invoiced money instead of modelled estimates. Check first, then import.
import { useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  importBrokerStatement,
  listStatementImportPortfolios,
  type StatementImportResult,
} from "@/lib/broker-statement-import.functions";

const money = (n: number, ccy: string) =>
  n.toLocaleString("en-GB", { style: "currency", currency: /^[A-Za-z]{3}$/.test(ccy) ? ccy.toUpperCase() : "GBP" });

export function BrokerStatementImportCard() {
  const queryClient = useQueryClient();
  const listBooks = useServerFn(listStatementImportPortfolios);
  const runImport = useServerFn(importBrokerStatement);
  const fileRef = useRef<HTMLInputElement>(null);

  const { data: books } = useQuery({
    queryKey: ["statement-import-portfolios"],
    queryFn: () => listBooks(),
  });

  const [portfolioId, setPortfolioId] = useState<string | null>(null);
  const [text, setText] = useState("");
  const [fileName, setFileName] = useState<string | null>(null);
  const [busy, setBusy] = useState<"check" | "import" | null>(null);
  const [result, setResult] = useState<StatementImportResult | null>(null);

  const selected = portfolioId ?? books?.[0]?.id ?? null;

  const onFile = async (file: File | undefined) => {
    if (!file) return;
    const body = await file.text();
    setText(body);
    setFileName(file.name);
    setResult(null);
  };

  const run = async (dryRun: boolean) => {
    if (!selected) {
      toast.error("Pick the account this statement belongs to.");
      return;
    }
    if (!text.trim()) {
      toast.error("Choose a statement file, or paste its contents.");
      return;
    }
    setBusy(dryRun ? "check" : "import");
    try {
      const res = await runImport({ data: { portfolioId: selected, text, dryRun } });
      setResult(res);
      if (!dryRun) {
        await queryClient.invalidateQueries({ queryKey: ["cost-dashboard"] });
        await queryClient.invalidateQueries({ queryKey: ["statement-import-portfolios"] });
      }
      if (res.chargesParsed === 0) toast.error(res.message);
      else if (dryRun) toast.success(res.message);
      else if (res.fillsUpdated > 0) toast.success(res.message);
      else toast.warning(res.message);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not read that statement");
    } finally {
      setBusy(null);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Import a broker statement</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-sm text-muted-foreground">
          Your broker's live feed lists the trades but not the money charged, so fees here are still
          estimates. Download your booking or charge statement (CSV) and load it below — every trade
          it covers switches to the amount you were actually billed, and the AI's cost floor follows.
        </p>

        <div className="flex flex-wrap items-center gap-3">
          <Select value={selected ?? undefined} onValueChange={setPortfolioId}>
            <SelectTrigger className="w-[240px]">
              <SelectValue placeholder="Choose account" />
            </SelectTrigger>
            <SelectContent>
              {(books ?? []).map((b) => (
                <SelectItem key={b.id} value={b.id}>
                  {b.name} — {b.invoicedFills}/{b.fills} billed
                </SelectItem>
              ))}
            </SelectContent>
          </Select>

          <input
            ref={fileRef}
            type="file"
            accept=".csv,.tsv,.txt,text/csv,text/plain"
            className="hidden"
            onChange={(e) => void onFile(e.target.files?.[0])}
          />
          <Button variant="outline" size="sm" onClick={() => fileRef.current?.click()}>
            {fileName ? `File: ${fileName}` : "Choose statement file"}
          </Button>
          <Button size="sm" variant="secondary" disabled={busy != null} onClick={() => void run(true)}>
            {busy === "check" ? "Checking…" : "Check file"}
          </Button>
          <Button size="sm" disabled={busy != null} onClick={() => void run(false)}>
            {busy === "import" ? "Importing…" : "Import charges"}
          </Button>
        </div>

        <Textarea
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            setFileName(null);
            setResult(null);
          }}
          placeholder="…or paste the statement rows here, including the header line."
          className="h-28 font-mono text-xs"
        />

        {result && (
          <div className="space-y-3 rounded-md border p-3 text-sm">
            <div className="flex flex-wrap items-center gap-2">
              <Badge variant={result.chargesParsed > 0 ? "default" : "destructive"}>
                {result.chargesParsed} charge rows
              </Badge>
              {Object.entries(result.totalsByCurrency).map(([ccy, amt]) => (
                <Badge key={ccy} variant="outline">
                  {money(amt, ccy)} billed
                </Badge>
              ))}
              {!result.dryRun && (
                <Badge variant={result.fillsUpdated > 0 ? "default" : "secondary"}>
                  {result.fillsUpdated} trades repriced
                </Badge>
              )}
              {result.unitMismatches > 0 && (
                <Badge variant="destructive">{result.unitMismatches} held back (pence/pound check)</Badge>
              )}
            </div>
            <p className="text-muted-foreground">{result.message}</p>
            {!result.dryRun && result.unmatchedCharges > 0 && (
              <p className="text-muted-foreground">
                {result.unmatchedCharges} statement rows matched no trade in this account — usually
                trades placed elsewhere, or a different account's statement.
              </p>
            )}
            {result.skipped.length > 0 && (
              <p className="text-muted-foreground">
                Skipped {result.skipped.length} rows: {result.skipped[0]?.reason}.
              </p>
            )}
            {result.unmappedColumns.length > 0 && (
              <p className="text-xs text-muted-foreground">
                Columns not used: {result.unmappedColumns.join(", ")}
              </p>
            )}
            {result.preview.length > 0 && (
              <div className="overflow-x-auto">
                <table className="w-full text-xs">
                  <thead className="text-muted-foreground">
                    <tr>
                      <th className="text-left font-normal">Symbol</th>
                      <th className="text-left font-normal">Side</th>
                      <th className="text-right font-normal">Qty</th>
                      <th className="text-left font-normal">Traded</th>
                      <th className="text-right font-normal">Charge</th>
                    </tr>
                  </thead>
                  <tbody>
                    {result.preview.map((p, i) => (
                      <tr key={i} className="border-t">
                        <td className="py-1">{p.symbol ?? "—"}</td>
                        <td>{p.side ?? "—"}</td>
                        <td className="text-right">{p.quantity ?? "—"}</td>
                        <td>{p.tradedAt ? p.tradedAt.slice(0, 10) : "—"}</td>
                        <td className="text-right">{money(p.total, p.currency)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
