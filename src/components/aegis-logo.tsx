import { cn } from "@/lib/utils";

type AegisLogoProps = {
  className?: string;
  size?: number;
};

/** The Aegis shield-and-growth brand mark. */
export function AegisLogo({ className, size = 32 }: AegisLogoProps) {
  return (
    <img
      src="/icon-192.png"
      alt=""
      aria-hidden="true"
      width={size}
      height={size}
      className={cn("shrink-0 rounded-md", className)}
    />
  );
}