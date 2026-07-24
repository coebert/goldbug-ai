// Static check: every `*.functions.ts` file must be a thin wrapper.
//
// Motivation: TanStack's server-fn Vite plugin splits `.handler()` bodies
// into a server-only chunk. Sibling helpers/config/constants in the SAME
// module are stripped from the client bundle but ALSO deleted from the
// server chunk that ships to Workers — causing `ReferenceError: <helper>
// is not defined` at runtime even when the build + typecheck are green
// (see `tanstack-serverfn-splitting` knowledge). Symptoms only appear in
// production; dev + tests pass.
//
// Rule enforced here: module scope of a `*.functions.ts` file may contain
// only:
//   - import / export-from statements
//   - type / interface aliases and `export type` re-exports
//   - `export const X = createServerFn(...).…` chains
//   - trivial helper constants used ONLY inside the chain builder
// Any function declaration, non-trivial const, or top-level side effect is
// rejected. Move it to a sibling `.server.ts` module and import.
//
// Run: `bun run scripts/check-serverfn-shape.ts` (also wired into `lint`).

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name.startsWith(".")) continue;
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, out);
    else if (name.endsWith(".functions.ts") || name.endsWith(".functions.tsx")) out.push(p);
  }
  return out;
}

const ALLOWED_TOP = [
  /^import\b/,
  /^export\s+(type|interface)\b/,
  /^export\s+\*\s+from\b/,
  /^export\s+\{[^}]*\}\s+from\b/,
  /^type\s+\w+\s*=/,
  /^interface\s+\w+/,
  /^export\s+const\s+\w+\s*=\s*createServerFn\b/,
  /^const\s+\w+Schema\s*=\s*[A-Z]/, // schema aliases (Zod)
  /^\/\//, // comment
  /^\/\*/,
  /^\*/,
  /^$/,
];

function isAllowedBlock(block: string): boolean {
  const first = block.trimStart().split("\n", 1)[0]!;
  return ALLOWED_TOP.some((re) => re.test(first));
}

// Split top-level statements by matching braces / parens at depth 0.
function splitTopLevel(src: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let start = 0;
  let inStr: string | null = null;
  let inLineComment = false;
  let inBlockComment = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i]!;
    const n = src[i + 1];
    if (inLineComment) { if (c === "\n") inLineComment = false; continue; }
    if (inBlockComment) { if (c === "*" && n === "/") { inBlockComment = false; i++; } continue; }
    if (inStr) { if (c === "\\") { i++; continue; } if (c === inStr) inStr = null; continue; }
    if (c === "/" && n === "/") { inLineComment = true; i++; continue; }
    if (c === "/" && n === "*") { inBlockComment = true; i++; continue; }
    if (c === '"' || c === "'" || c === "`") { inStr = c; continue; }
    if (c === "{" || c === "(" || c === "[") depth++;
    else if (c === "}" || c === ")" || c === "]") depth--;
    else if (c === ";" && depth === 0) {
      out.push(src.slice(start, i + 1));
      start = i + 1;
    } else if (c === "\n" && depth === 0) {
      // keep newlines with the next block
    }
  }
  if (start < src.length) out.push(src.slice(start));
  return out.map((s) => s.trim()).filter(Boolean);
}

const errors: string[] = [];
const files = walk(join(ROOT, "src"));
for (const file of files) {
  const src = readFileSync(file, "utf8");
  const blocks = splitTopLevel(src);
  for (const b of blocks) {
    if (!isAllowedBlock(b)) {
      const first = b.split("\n", 1)[0]!.slice(0, 100);
      errors.push(`${relative(ROOT, file)}: disallowed top-level statement: ${first}`);
    }
  }
}

if (errors.length) {
  console.error("check-serverfn-shape: violations found");
  for (const e of errors) console.error("  " + e);
  console.error(
    "\nMove helpers/config to a sibling `.server.ts` module and import them. " +
    "See src/lib/_server/README.md and tanstack-serverfn-splitting knowledge.",
  );
  process.exit(1);
}
console.log(`check-serverfn-shape: OK (${files.length} files)`);
