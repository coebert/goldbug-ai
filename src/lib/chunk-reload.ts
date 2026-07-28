// Detect stale-chunk / module-script import failures after a redeploy and
// force a one-shot hard reload so the browser re-fetches the current HTML
// shell (which references the new hashed chunks). Guarded via sessionStorage
// so we never loop when the failure is a real bug rather than a stale cache.

const RELOAD_FLAG = "aegis:chunk-reload-at";
const RELOAD_COOLDOWN_MS = 30_000;

const CHUNK_ERROR_PATTERNS = [
  /Importing a module script failed/i,
  /Failed to fetch dynamically imported module/i,
  /error loading dynamically imported module/i,
  /Unable to preload CSS/i,
  /ChunkLoadError/i,
];

function isChunkError(message: string | undefined | null): boolean {
  if (!message) return false;
  return CHUNK_ERROR_PATTERNS.some((re) => re.test(message));
}

function shouldReload(): boolean {
  try {
    const last = Number(sessionStorage.getItem(RELOAD_FLAG) ?? "0");
    if (Number.isFinite(last) && Date.now() - last < RELOAD_COOLDOWN_MS) return false;
    sessionStorage.setItem(RELOAD_FLAG, String(Date.now()));
    return true;
  } catch {
    return true;
  }
}

function forceReload() {
  // Cache-bust the current URL so the CDN/browser skips any stale HTML.
  const url = new URL(window.location.href);
  url.searchParams.set("_r", Date.now().toString(36));
  window.location.replace(url.toString());
}

let installed = false;

export function installChunkReloadHandler() {
  if (installed || typeof window === "undefined") return;
  installed = true;

  window.addEventListener("error", (event) => {
    const msg = event?.message ?? (event?.error instanceof Error ? event.error.message : "");
    if (isChunkError(msg) && shouldReload()) forceReload();
  });

  window.addEventListener("unhandledrejection", (event) => {
    const reason = event?.reason;
    const msg =
      typeof reason === "string" ? reason : reason instanceof Error ? reason.message : "";
    if (isChunkError(msg) && shouldReload()) forceReload();
  });
}
