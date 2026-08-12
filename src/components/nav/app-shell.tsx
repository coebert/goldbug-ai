import type { ReactNode } from "react";
import { DesktopRail, useRailCollapsed } from "@/components/nav/desktop-rail";

/**
 * Wraps every page: persistent left rail on desktop, floating tab bar
 * (rendered by the root) on mobile. The content column is offset by
 * the rail width so nothing sits underneath it.
 */
export function AppShell({ children }: { children: ReactNode }) {
  const collapsed = useRailCollapsed();
  return (
    <>
      <DesktopRail />
      <div className={collapsed ? "lg:pl-[4.25rem]" : "lg:pl-52"}>{children}</div>
    </>
  );
}
