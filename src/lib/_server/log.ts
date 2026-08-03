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
  const payload: Record<string, unknown> = {
    ts: new Date().toISOString(),
    level,
    prefix,
    msg,
  };
  if (meta) {
    for (const [k, v] of Object.entries(meta)) {
      payload[k] = v instanceof Error ? serializeError(v) : v;
    }
  }
  // Two-arg shape: `<prefix> <msg>` first, JSON payload second. This keeps
  // Cloudflare / Node consoles readable (message on the tag line, structured
  // context inline) and preserves the historical call shape that existing
  // `console.warn` spies in the test suite pattern-match on.
  const headline = `${prefix} ${msg}`;
  const json = JSON.stringify(payload);
  if (level === "error") console.error(headline, json);
  else if (level === "warn") console.warn(headline, json);
  else if (level === "info") console.info(headline, json);
  else console.log(headline, json);
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

/**
 * Console-compatible structured logger.
 *
 * Phase 5: drop-in replacement for raw `console.warn(...)` / `console.error(...)`
 * in server modules that log with positional arguments. The call shape is
 * unchanged (`log.warn("news: gdelt failed", err)`), but the output is a single
 * JSON record carrying `prefix`, the leading message and the remaining
 * arguments, so production logs stay filterable.
 *
 * The headline (first console argument) keeps the original message verbatim so
 * existing greps and test spies keep matching.
 */
export function createConsoleLogger(prefix: string) {
  const write = (level: Level, args: unknown[]) => {
    const [head, ...rest] = args;
    const msg = typeof head === "string" ? head : JSON.stringify(head ?? null);
    const meta: LogMeta = {};
    if (rest.length > 0) {
      meta.args = rest.map((a) => (a instanceof Error ? serializeError(a) : a));
    }
    const payload: Record<string, unknown> = {
      ts: new Date().toISOString(),
      level,
      prefix,
      msg,
      ...meta,
    };
    const json = JSON.stringify(payload);
    if (level === "error") console.error(msg, json);
    else if (level === "warn") console.warn(msg, json);
    else if (level === "info") console.info(msg, json);
    else console.log(msg, json);
  };
  return {
    prefix,
    log: (...args: unknown[]) => write("debug", args),
    debug: (...args: unknown[]) => write("debug", args),
    info: (...args: unknown[]) => write("info", args),
    warn: (...args: unknown[]) => write("warn", args),
    error: (...args: unknown[]) => write("error", args),
  };
}

export type ConsoleLogger = ReturnType<typeof createConsoleLogger>;
