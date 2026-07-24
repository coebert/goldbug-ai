import { useEffect, useState } from "react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { AlertTriangle } from "lucide-react";

/**
 * Typed-confirmation dialog for destructive/high-stakes actions.
 * When `requireText` is set, the confirm button stays disabled until the user
 * types the exact phrase. When it's omitted the dialog is a plain confirm.
 */
export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  requireText,
  confirmLabel = "Confirm",
  cancelLabel = "Cancel",
  destructive = true,
  onConfirm,
  extra,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  title: string;
  description?: React.ReactNode;
  requireText?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  destructive?: boolean;
  onConfirm: () => void;
  extra?: React.ReactNode;
}) {
  const [typed, setTyped] = useState("");
  useEffect(() => {
    if (!open) setTyped("");
  }, [open]);
  const ready = !requireText || typed.trim() === requireText;

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle className="flex items-center gap-2">
            {destructive && <AlertTriangle className="h-5 w-5 text-destructive" />}
            {title}
          </AlertDialogTitle>
          {description && (
            <AlertDialogDescription asChild>
              <div className="space-y-2 text-sm text-muted-foreground">{description}</div>
            </AlertDialogDescription>
          )}
        </AlertDialogHeader>
        {extra}
        {requireText && (
          <div className="space-y-2">
            <Label className="text-xs">
              Type <span className="font-mono font-semibold text-foreground">{requireText}</span> to confirm
            </Label>
            <Input
              autoFocus
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              placeholder={requireText}
              autoComplete="off"
              spellCheck={false}
            />
          </div>
        )}
        <AlertDialogFooter>
          <AlertDialogCancel>{cancelLabel}</AlertDialogCancel>
          <AlertDialogAction
            disabled={!ready}
            onClick={(e) => {
              if (!ready) {
                e.preventDefault();
                return;
              }
              onConfirm();
            }}
            className={destructive ? "bg-destructive text-destructive-foreground hover:bg-destructive/90" : undefined}
          >
            {confirmLabel}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
