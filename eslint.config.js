import js from "@eslint/js";
import eslintPluginPrettier from "eslint-plugin-prettier/recommended";
import globals from "globals";
import reactHooks from "eslint-plugin-react-hooks";
import reactRefresh from "eslint-plugin-react-refresh";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["dist", ".output", ".vinxi"] },
  {
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    files: ["**/*.{ts,tsx}"],
    languageOptions: {
      ecmaVersion: 2020,
      globals: globals.browser,
    },
    plugins: {
      "react-hooks": reactHooks,
      "react-refresh": reactRefresh,
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      "no-restricted-imports": [
        "error",
        {
          paths: [
            {
              name: "server-only",
              message:
                "TanStack Start does not use the Next.js `server-only` package. Rename the module to `*.server.ts` or mark it with `@tanstack/react-start/server-only`.",
            },
          ],
        },
      ],
      "react-refresh/only-export-components": ["warn", { allowConstantExport: true }],
      "@typescript-eslint/no-unused-vars": "off",
    },
  },
  // Boundary: routes + components (client-reachable) must not statically
  // import server-only modules. Server logic reachable from the client must
  // go through a `createServerFn` in a `.functions.ts` file, which the
  // TanStack plugin stubs on the client. `.server.ts` imports here would
  // pull `supabaseAdmin` / secrets into the client bundle graph.
  {
    files: ["src/routes/**/*.{ts,tsx}", "src/components/**/*.{ts,tsx}", "src/hooks/**/*.{ts,tsx}"],
    ignores: ["src/routes/api/**"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["@/lib/*.server", "@/lib/_server/*", "@/integrations/supabase/client.server"],
              message:
                "Server-only module. Wrap the call in a createServerFn (`*.functions.ts`) instead of importing it from a route/component/hook.",
            },
          ],
        },
      ],
    },
  },
  // `.functions.ts` files may only import `client.server` inside a
  // handler body (dynamic `await import(...)`). A static import here
  // ships `supabaseAdmin` into the client bundle for every route that
  // reaches the module.
  {
    files: ["src/**/*.functions.ts", "src/**/*.functions.tsx"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [
            {
              name: "@/integrations/supabase/client.server",
              message:
                "Move this to a dynamic `await import('@/integrations/supabase/client.server')` inside the `.handler()` body — a static import at module scope leaks admin credentials into the client bundle graph.",
            },
          ],
        },
      ],
    },
  },
  eslintPluginPrettier,
);
