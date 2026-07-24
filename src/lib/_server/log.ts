// Structured server-side logger.
//
// Phase 6: replaces ad-hoc `console.warn("SECURITY:...")` / `console.error(...)`
// call sites with a single levelled JSON writer. Every line is a single JSON
// object with:
//   { ts, level, prefix, msg, ...meta }
//
// The `prefix` is preserved verbatim (e.g. `SECURITY:pending_slices`) so
// existing greps / alert rules continue to work while callers get typed
// metadata instead of positional `console.warn` arguments.
//
// This module is server-only (imported from `.server.ts` / route handlers).
// It intentionally has no dependencies so it can be adopted from anywhere.

type Level = "debug" | "info" | "warn" | "error";

export interface LogMeta {
  [key: string]: unknown;
}

function serializeError(err: unknown): { message: string; name?: string; stack?: string } {
  if (err instanceof Error) {
    return { message: err.message, name: err.name, stack: err.stack };
  }
  return { message: typeof err === "string" ? err : JSON.stringify(err) };
}

function emit(level: Level, prefix: string, msg: string, meta?: LogMeta) {
  const line: Record<string, unknown> = {
    ts: new Date().toISOString(),
    level,
    prefix,
    msg,
  };
  if (meta) {
    for (const [k, v] of Object.entries(meta)) {
      line[k] = v instanceof Error ? serializeError(v) : v;
    }
  }
  const text = `${prefix} ${msg} ${JSON.stringify(line)}`;
  // Route by level so Cloudflare / Node consoles colour and filter correctly.
  if (level === "error") console.error(text);
  else if (level === "warn") console.warn(text);
  else if (level === "info") console.info(text);
  else console.log(text);
}

/**
 * Create a logger bound to a stable prefix. The prefix is emitted at the
 * front of every line so `grep "SECURITY:pending_slices"` still works.
 */
export function createLogger(prefix: string) {
  return {
    prefix,
    debug: (msg: string, meta?: LogMeta) => emit("debug", prefix, msg, meta),
    info: (msg: string, meta?: LogMeta) => emit("info", prefix, msg, meta),
    warn: (msg: string, meta?: LogMeta) => emit("warn", prefix, msg, meta),
    error: (msg: string, meta?: LogMeta) => emit("error", prefix, msg, meta),
    child: (suffix: string) => createLogger(`${prefix}:${suffix}`),
  };
}

export type Logger = ReturnType<typeof createLogger>;

/**
 * Shorthand for security-relevant events. Keeps the `SECURITY:` prefix that
 * ops greps and the security-alerts pipeline rely on.
 */
export function logSecurity(event: string, msg: string, meta?: LogMeta) {
  emit("warn", `SECURITY:${event}`, msg, meta);
}
