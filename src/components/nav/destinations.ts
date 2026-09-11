import {
  Target,
  Home,
  LineChart,
  FlaskConical,
  Receipt,
  Activity,
  Wrench,
  GitCompare,
  Network,
  BookOpen,
  Brain,
  Sparkles,
  Plug,
  RefreshCw,
  Shield,
  Settings as SettingsIcon,
  Ban,
  SlidersHorizontal,
  LifeBuoy,
  FileText,
  Briefcase,
  type LucideIcon,
} from "lucide-react";

/**
 * Single source of truth for "where can I go in this app".
 *
 * Both the mobile tab bar and its "More" sheet, and the desktop left
 * rail, are generated from this registry. Keeping one list is what
 * stops the tab bar and the sheet drifting apart — previously "More"
 * silently navigated to /compare and a dozen routes were reachable
 * only by knowing an in-card link existed.
 */
export type AreaId = "home" | "markets" | "research" | "trades" | "system";

export type Destination = {
  /** Router path. Typed loosely on purpose: the registry is data. */
  to: string;
  label: string;
  /** One-line plain-English description shown in the More sheet. */
  hint: string;
  icon: LucideIcon;
  area: AreaId;
  /** Match only the exact path when marking active. */
  exact?: boolean;
  /** Show as a top-level tab / rail entry. */
  primary?: boolean;
  /** Short label for the cramped mobile tab bar (defaults to label). */
  tabLabel?: string;
  /** Extra words that should match in the More sheet search box. */
  keywords?: string;
};

export const AREAS: ReadonlyArray<{ id: AreaId; label: string }> = [
  { id: "home", label: "Your money" },
  { id: "markets", label: "Markets" },
  { id: "research", label: "Research" },
  { id: "trades", label: "Trades" },
  { id: "system", label: "System" },
];

export const DESTINATIONS: ReadonlyArray<Destination> = [
  // --- Home -------------------------------------------------------
  {
    to: "/",
    label: "Home",
    hint: "Your portfolios, today's change and what to do next.",
    icon: Home,
    area: "home",
    exact: true,
    primary: true,
    keywords: "dashboard portfolios equity",
  },
  {
    to: "/get-started",
    label: "Get started",
    hint: "Three-step guided demo with £1000 of pretend money.",
    icon: Sparkles,
    area: "home",
    keywords: "demo onboarding tutorial",
  },
  {
    to: "/learn",
    label: "Learn",
    hint: "Plain-English explanations of every concept the AI uses.",
    icon: BookOpen,
    area: "home",
    keywords: "help glossary jargon",
  },

  // --- Markets ----------------------------------------------------
  {
    to: "/markets",
    label: "Markets",
    hint: "Market pulse, moving-average trends and symbol charts.",
    icon: LineChart,
    area: "markets",
    primary: true,
    keywords: "pulse sma rsi chart price trend",
  },
  {
    to: "/compare",
    label: "Compare",
    hint: "Portfolios and benchmarks side by side.",
    icon: GitCompare,
    area: "markets",
    keywords: "benchmark side by side",
  },
  {
    to: "/symbols",
    label: "Symbols",
    hint: "Each name's track record, dealing cost, price levels and your own limits.",
    icon: SlidersHorizontal,
    area: "markets",
    keywords: "signal strength limits stop target cap per symbol overrides",
  },
  {
    to: "/spillover",
    label: "Spillover",
    hint: "How moves in one market spread into the others.",
    icon: Network,
    area: "markets",
    keywords: "correlation contagion heatmap",
  },

  // --- Research ---------------------------------------------------
  {
    to: "/research",
    label: "Research",
    hint: "Scanners and backtests — test an idea before the AI trades it.",
    icon: FlaskConical,
    area: "research",
    primary: true,
    keywords: "backtest scanner reclaim setup insider batching",
  },
  {
    to: "/decision-model",
    label: "Trading playbook",
    hint: "The rules the AI wrote from your own trading record.",
    icon: Brain,
    area: "research",
    keywords: "playbook rules learned history edge signals",

  },

  {
    to: "/simulation-report",
    label: "Simulation report",
    hint: "Full write-up of the latest simulation run.",
    icon: FileText,
    area: "research",
    keywords: "sim report",
  },

  // --- Trades -----------------------------------------------------
  {
    to: "/trades",
    label: "Trades",
    hint: "Every order the AI placed, why, and whether it filled.",
    icon: Receipt,
    area: "trades",
    primary: true,
    keywords: "orders fills executions",
  },
  {
    to: "/positions",
    label: "Portfolio positions",
    tabLabel: "Positions",
    hint: "Each holding's size, cost, P&L and dealing-cost floor.",
    icon: Briefcase,
    area: "trades",
    keywords: "portfolio holdings positions cost basis unrealised realised pnl weight",
  },
  {
    to: "/live-dashboard",
    label: "Live dashboard",
    hint: "Real-time positions, broker orders, fills, and execution P&L.",
    icon: Activity,
    area: "trades",
    keywords: "live order book positions fills execution pnl",
  },
  {
    to: "/pnl",
    label: "P&L vs AI",
    tabLabel: "P&L",
    hint: "Your real profit and loss beside the AI's replay, with every fee and tax.",
    icon: GitCompare,
    area: "trades",
    keywords: "profit loss shadow backtest gap fees stamp duty slippage comparison",
  },
  {
    to: "/daily-report",
    label: "Daily AI report",
    tabLabel: "Report",
    hint: "What the AI considered today, why it traded, and why it passed.",
    icon: FileText,
    area: "trades",
    keywords: "daily report decisions rationale considered passed",
  },
  {
    to: "/costs",
    label: "Dealing costs",
    tabLabel: "Costs",
    hint: "What each name really costs to trade, and the hurdle new buys must clear.",
    icon: Receipt,
    area: "trades",
    keywords: "costs fees commission stamp duty slippage floor hurdle spread",
  },
  {
    to: "/core-progress",
    label: "Core progress",
    tabLabel: "Core",
    hint: "How much of your long-term core is built, and the cash and date to finish it.",
    icon: Target,
    area: "trades",
    keywords: "core allocation target progress build cash needed date vwrl tracker",
  },


  // --- System -----------------------------------------------------
  {
    to: "/saxo-status",
    label: "Broker status",
    tabLabel: "Broker",
    hint: "Connection health, cash sync and reconciliation.",
    icon: Plug,
    area: "system",
    primary: true,
    keywords: "saxo connection cash",
  },
  {
    to: "/saxo-reconnect",
    label: "Reconnect broker",
    hint: "Re-authorise the Saxo connection.",
    icon: RefreshCw,
    area: "system",
    keywords: "oauth login saxo",
  },
  {
    to: "/broker-blocks",
    label: "Blocked instruments",
    hint: "Instruments the broker refused, and why.",
    icon: Ban,
    area: "system",
    keywords: "suitability rejection",
  },
  {
    to: "/hedge-fallbacks",
    label: "Hedge fallbacks",
    hint: "Substitutes used when a hedge instrument is unavailable.",
    icon: LifeBuoy,
    area: "system",
    keywords: "gold tail hedge",
  },
  {
    to: "/settings",
    label: "Settings",
    hint: "Notifications, security and display preferences.",
    icon: SettingsIcon,
    area: "system",
    keywords: "notifications alerts preferences 2fa",
  },
  {
    to: "/admin",
    label: "Admin",
    hint: "Run controls, scheduler and diagnostics.",
    icon: Shield,
    area: "system",
    keywords: "run lock scheduler diagnostics",
  },
];

/** The five entries that get a tab / rail slot. */
export const PRIMARY: ReadonlyArray<Destination> = DESTINATIONS.filter((d) => d.primary);

export function destinationsByArea(area: AreaId): Destination[] {
  return DESTINATIONS.filter((d) => d.area === area);
}

/** Case-insensitive match across label, hint, path and keywords. */
export function searchDestinations(query: string): Destination[] {
  const q = query.trim().toLowerCase();
  if (!q) return [...DESTINATIONS];
  return DESTINATIONS.filter((d) =>
    `${d.label} ${d.hint} ${d.to} ${d.keywords ?? ""}`.toLowerCase().includes(q),
  );
}

/** Which area a pathname belongs to, for active highlighting. */
export function areaForPath(pathname: string): AreaId {
  if (pathname === "/") return "home";
  if (pathname.startsWith("/markets") || pathname.startsWith("/market/") || pathname.startsWith("/symbols") || pathname.startsWith("/compare") || pathname.startsWith("/spillover")) {
    return "markets";
  }
  if (
    pathname.startsWith("/research") ||
    pathname.startsWith("/simulation-report") ||
    pathname.startsWith("/walk-forward") ||
    pathname.startsWith("/long-horizon")
  ) {
    return "research";
  }
  if (pathname.startsWith("/trades") || pathname.startsWith("/daily-report")) return "trades";
  if (
    pathname.startsWith("/saxo") ||
    pathname.startsWith("/admin") ||
    pathname.startsWith("/settings") ||
    pathname.startsWith("/broker-blocks") ||
    pathname.startsWith("/hedge-fallbacks")
  ) {
    return "system";
  }
  return "home";
}
