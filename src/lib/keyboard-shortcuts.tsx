import { useEffect, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";

/**
 * Phase 5 — global keyboard shortcuts.
 *
 * Prefix-style ("g h", "g t", "g c") jumps mirror common web-app
 * conventions (GitHub, Linear). Single keys ("n", "?", "/") work
 * from anywhere except when the user is typing into an input,
 * textarea, contenteditable, or a Radix dialog role="dialog"
 * descendant (the command palette handles its own keys).
 */
function isTypingTarget(e: KeyboardEvent): boolean {
  const t = e.target as HTMLElement | null;
  if (!t) return false;
  const tag = t.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
  if (t.isContentEditable) return true;
  return false;
}

export function useGlobalShortcuts() {
  const navigate = useNavigate();
  const [helpOpen, setHelpOpen] = useState(false);

  useEffect(() => {
    let pendingG: number | null = null;
    const clearPending = () => {
      if (pendingG !== null) {
        window.clearTimeout(pendingG);
        pendingG = null;
      }
    };

    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (isTypingTarget(e)) return;

      const k = e.key;

      // Sequence: g then h/t/c/l
      if (pendingG !== null) {
        clearPending();
        const map: Record<string, () => void> = {
          h: () => navigate({ to: "/" }),
          t: () => navigate({ to: "/trades" }),
          c: () => navigate({ to: "/compare" }),
          l: () => navigate({ to: "/learn" }),
        };
        const go = map[k.toLowerCase()];
        if (go) {
          e.preventDefault();
          go();
        }
        return;
      }

      if (k === "g" || k === "G") {
        pendingG = window.setTimeout(clearPending, 900);
        return;
      }

      if (k === "n") {
        e.preventDefault();
        navigate({ to: "/", hash: "create-portfolio" });
        return;
      }

      if (k === "?") {
        e.preventDefault();
        setHelpOpen(true);
        return;
      }

      if (k === "/") {
        // Focus the header search / command palette trigger.
        const btn = document.querySelector<HTMLButtonElement>(
          '[data-shortcut="command-palette-trigger"]',
        );
        if (btn) {
          e.preventDefault();
          btn.click();
        }
      }
    };

    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      clearPending();
    };
  }, [navigate]);

  return { helpOpen, setHelpOpen };
}

export function ShortcutHelpDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
}) {
  const rows: Array<[string, string]> = [
    ["g h", "Go to Home"],
    ["g t", "Go to Trades"],
    ["g c", "Go to Compare"],
    ["g l", "Go to Learn"],
    ["n", "New portfolio"],
    ["/", "Open search / command palette"],
    ["⌘ K", "Open command palette"],
    ["?", "Show this shortcut help"],
  ];
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Keyboard shortcuts</DialogTitle>
          <DialogDescription>
            Shortcuts are ignored while typing in an input.
          </DialogDescription>
        </DialogHeader>
        <ul className="mt-2 divide-y divide-border/60 rounded-md border border-border/60 bg-surface-sunken">
          {rows.map(([keys, label]) => (
            <li
              key={keys}
              className="flex items-center justify-between gap-4 px-3 py-2 text-sm"
            >
              <span className="text-foreground">{label}</span>
              <kbd className="inline-flex select-none items-center gap-1 rounded border border-border bg-background px-2 py-0.5 font-mono text-[11px] font-medium text-muted-foreground">
                {keys}
              </kbd>
            </li>
          ))}
        </ul>
      </DialogContent>
    </Dialog>
  );
}

export function GlobalShortcutsHost() {
  const { helpOpen, setHelpOpen } = useGlobalShortcuts();
  return <ShortcutHelpDialog open={helpOpen} onOpenChange={setHelpOpen} />;
}
