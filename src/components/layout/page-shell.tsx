import type { ReactNode } from "react";

/**
 * The single page template.
 *
 * Before this, every route invented its own header, container width,
 * padding and back link, so nothing told you where you were or what
 * the page was for. `PageShell` gives all routes the same grammar:
 *
 *   title  ·  one-line purpose  ·  actions
 *   [context strip]
 *   [sticky sub-nav, e.g. portfolio tabs]
 *   content
 *
 * Width is one decision made here (`max-w-6xl`, widening at 2xl) so
 * wide tables stop scrolling sideways on large monitors while phones
 * keep a comfortable gutter.
 */
export function PageShell({
  title,
  purpose,
  actions,
  context,
  subnav,
  children,
  width = "default",
  className = "",
}: {
  title: ReactNode;
  /** One plain-English line saying what this page is for. */
  purpose?: ReactNode;
  /** Right-aligned page actions (buttons, toggles). */
  actions?: ReactNode;
  /** Optional strip under the title: selectors, badges, last-run time. */
  context?: ReactNode;
  /** Sticky sub-navigation rendered full-bleed above the content. */
  subnav?: ReactNode;
  children: ReactNode;
  /** `narrow` for reading pages (Learn, Settings), `wide` for tables. */
  width?: "narrow" | "default" | "wide";
  className?: string;
}) {
  const max =
    width === "narrow" ? "max-w-3xl" : width === "wide" ? "max-w-7xl" : "max-w-6xl 2xl:max-w-7xl";

  return (
    <>
      {subnav && <div className={`mx-auto w-full ${max} px-4`}>{subnav}</div>}
      <main className={`mx-auto w-full min-w-0 ${max} px-4 pb-24 pt-5 sm:pt-7 ${className}`}>
        <header className="mb-5 grid grid-cols-[minmax(0,1fr)_auto] items-start gap-3 sm:flex sm:flex-wrap sm:items-center sm:justify-between sm:gap-4">
          <div className="min-w-0">
            <h1 className="truncate font-display text-2xl font-semibold tracking-tight sm:text-[1.75rem]">
              {title}
            </h1>
            {purpose && (
              <p className="mt-1 text-sm leading-snug text-muted-foreground">{purpose}</p>
            )}
          </div>
          {actions && (
            <div className="flex shrink-0 flex-wrap items-center justify-end gap-2">{actions}</div>
          )}
        </header>

        {context && <div className="mb-5">{context}</div>}

        {children}
      </main>
    </>
  );
}

/**
 * A titled band of related cards inside a page. Gives long pages a
 * predictable rhythm and a stable anchor for the section index.
 */
export function PageSection({
  id,
  title,
  description,
  actions,
  children,
  className = "",
}: {
  id?: string;
  title?: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section id={id} className={`scroll-below-sticky mb-8 ${className}`}>
      {(title || actions) && (
        <div className="mb-3 grid grid-cols-[minmax(0,1fr)_auto] items-end gap-3">
          <div className="min-w-0">
            {title && (
              <h2 className="truncate font-display text-lg font-semibold tracking-tight">{title}</h2>
            )}
            {description && (
              <p className="mt-0.5 text-xs text-muted-foreground">{description}</p>
            )}
          </div>
          {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
        </div>
      )}
      {children}
    </section>
  );
}
