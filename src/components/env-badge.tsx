/**
 * Small chip that shows whether the running instance is preview or
 * production. Preview instances get a subtle warning tint so it is
 * always obvious you are not looking at the live deployment.
 */
export function EnvBadge() {
  if (typeof window === "undefined") return null;
  const host = window.location.hostname;
  const isPreview =
    host.includes("id-preview") ||
    host.includes("-dev.lovable.app") ||
    host === "localhost";
  if (!isPreview) return null;
  return (
    <span
      className="hidden items-center rounded-md border border-warning-soft bg-warning-soft px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-warning sm:inline-flex"
      title="You are viewing a preview build, not production."
    >
      Preview
    </span>
  );
}
