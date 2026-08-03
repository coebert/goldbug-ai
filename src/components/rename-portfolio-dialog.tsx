import { useEffect, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { renamePortfolio } from "@/lib/trading.functions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { qk } from "@/lib/query-keys";

export function RenamePortfolioDialog({
  open,
  onOpenChange,
  portfolioId,
  currentName,
  onRenamed,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  portfolioId: string;
  currentName: string;
  onRenamed?: (newName: string) => void;
}) {
  const [name, setName] = useState(currentName);
  const rename = useServerFn(renamePortfolio);
  const qc = useQueryClient();

  useEffect(() => {
    if (open) setName(currentName);
  }, [open, currentName]);

  const mut = useMutation({
    mutationFn: (n: string) => rename({ data: { id: portfolioId, name: n } }),
    onSuccess: (res) => {
      toast.success("Portfolio renamed");
      qc.invalidateQueries({ queryKey: qk.portfolios.all() });
      qc.invalidateQueries({ queryKey: qk.portfolio.detail(portfolioId) });
      onRenamed?.(res?.portfolio?.name ?? name);
      onOpenChange(false);
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : "Failed to rename"),
  });

  const trimmed = name.trim();
  const canSave = trimmed.length > 0 && trimmed.length <= 80 && trimmed !== currentName;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Rename portfolio</DialogTitle>
          <DialogDescription>
            Choose a new name for this portfolio. This only changes the label — trades, history and settings are untouched.
          </DialogDescription>
        </DialogHeader>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (canSave && !mut.isPending) mut.mutate(trimmed);
          }}
          className="space-y-3"
        >
          <div className="space-y-1.5">
            <Label htmlFor="portfolio-name">Name</Label>
            <Input
              id="portfolio-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={80}
              autoFocus
              placeholder="e.g. Balanced growth"
            />
            <p className="text-xs text-muted-foreground">{trimmed.length}/80 characters</p>
          </div>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)} disabled={mut.isPending}>
              Cancel
            </Button>
            <Button type="submit" disabled={!canSave || mut.isPending}>
              {mut.isPending ? "Saving…" : "Save name"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
