import { toast as sonner, type ExternalToast } from "sonner";

/**
 * Phase 5 — semantic toast helpers.
 *
 * Wraps sonner so every call site expresses intent, and the visual
 * treatment (icon colour, border) is derived from design tokens
 * rather than hand-rolled classes at each call site. The underlying
 * `sonner` variants are already themed via the `<Toaster />` config,
 * so this is a thin convenience layer that keeps intent grep-able.
 */
export const notify = {
  success(message: string, opts?: ExternalToast) {
    return sonner.success(message, opts);
  },
  error(message: string, opts?: ExternalToast) {
    return sonner.error(message, opts);
  },
  warning(message: string, opts?: ExternalToast) {
    return sonner.warning(message, opts);
  },
  info(message: string, opts?: ExternalToast) {
    return sonner.info(message, opts);
  },
  broker(message: string, opts?: ExternalToast) {
    return sonner(message, { ...opts, description: opts?.description ?? "Broker" });
  },
  ai(message: string, opts?: ExternalToast) {
    return sonner(message, { ...opts, description: opts?.description ?? "AI" });
  },
  system(message: string, opts?: ExternalToast) {
    return sonner(message, { ...opts, description: opts?.description ?? "System" });
  },
};

export { sonner as toast };
