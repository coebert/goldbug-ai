// Shared SSR render helper for component tests.
//
// `LiveHoldingsCard` (and other cards with a "Sync now" action) call
// `useQueryClient`, which throws outside a provider. Tests only care about the
// rendered markup, so they get a throwaway client with retries disabled.

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactElement } from "react";

export function renderWithQuery(node: ReactElement): string {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return renderToStaticMarkup(
    <QueryClientProvider client={client}>{node}</QueryClientProvider>,
  );
}
