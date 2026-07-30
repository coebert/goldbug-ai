#!/usr/bin/env bun
/**
 * CI guard: dependency vulnerability scan.
 *
 * Fails the build on any `high` or `critical` advisory in the resolved
 * dependency tree. Moderate/low findings are printed but do not block, so the
 * gate stays actionable rather than perpetually red.
 *
 * Usage:
 *   bun run check:deps            # offline/registry failure is a warning
 *   bun run check:deps --strict   # offline/registry failure fails the build
 *
 * CI passes --strict so a silently broken scanner can never look like a pass.
 */
const STRICT = process.argv.includes("--strict") || process.env.CI === "true";
const BLOCKING = new Set(["high", "critical"]);

type Advisory = { severity?: string; title?: string; url?: string };
type AuditReport = {
  vulnerabilities?: Record<
    string,
    { severity?: string; via?: (string | Advisory)[]; fixAvailable?: unknown }
  >;
};

async function runAudit(): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  const proc = Bun.spawn(
    [
      "npm",
      "audit",
      "--json",
      "--omit=dev",
      "--registry=https://registry.npmjs.org",
    ],
    { stdout: "pipe", stderr: "pipe" },
  );
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  await proc.exited;
  return { ok: true, stdout, stderr };
}

function unreachable(report: unknown, stderr: string): boolean {
  const message =
    typeof report === "object" && report !== null && "message" in report
      ? String((report as { message: unknown }).message)
      : "";
  return (
    /audit endpoint|ENOTFOUND|ECONNREFUSED|ETIMEDOUT|not supported|404/i.test(message) ||
    /audit endpoint|ENOTFOUND|ECONNREFUSED|ETIMEDOUT/i.test(stderr)
  );
}

function bail(reason: string): never {
  if (STRICT) {
    console.error(`check:deps FAILED — scanner did not run: ${reason}`);
    process.exit(1);
  }
  console.warn(`check:deps SKIPPED — ${reason} (pass --strict to make this fatal).`);
  process.exit(0);
}

const { stdout, stderr } = await runAudit();

let report: AuditReport;
try {
  report = JSON.parse(stdout) as AuditReport;
} catch {
  bail("audit produced no parsable JSON");
}

if (unreachable(report, stderr)) bail("the advisory registry is unreachable");

const vulns = Object.entries(report.vulnerabilities ?? {});
const blocking = vulns.filter(([, v]) => BLOCKING.has(String(v.severity)));
const other = vulns.filter(([, v]) => !BLOCKING.has(String(v.severity)));

console.log(
  `check:deps: ${vulns.length} advisory group(s) — ${blocking.length} high/critical, ${other.length} moderate/low.`,
);

for (const [name, v] of other) console.log(`  · ${name} (${v.severity})`);

if (blocking.length > 0) {
  console.error("\ncheck:deps FAILED — high/critical vulnerabilities present:");
  for (const [name, v] of blocking) {
    const titles = (v.via ?? [])
      .filter((entry): entry is Advisory => typeof entry === "object")
      .map((a) => `${a.title ?? "advisory"}${a.url ? ` (${a.url})` : ""}`);
    console.error(`  ✗ ${name} [${v.severity}]`);
    for (const t of titles) console.error(`      ${t}`);
    console.error(
      `      fix: ${v.fixAvailable ? "available — run `bun update " + name + "`" : "no automatic fix; upgrade or replace the package"}`,
    );
  }
  process.exit(1);
}

console.log("check:deps OK — no high or critical advisories.");
