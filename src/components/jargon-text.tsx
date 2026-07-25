// Renders a string with any recognised trading jargon wrapped in an
// <Explain> popover trigger. Drop-in replacement for plain text nodes:
//
//   <p><JargonText>{decision.rationale}</JargonText></p>
//
// The wrapper is a <span> so it can be nested inside <p>, <li>, <td>,
// tooltips, etc. without producing invalid HTML.

import { Fragment } from "react";
import { Explain } from "./explain";
import { scanJargon } from "@/lib/jargon-scan";

interface JargonTextProps {
  children?: string | null;
  /** Optional className applied to the outer span. */
  className?: string;
}

export function JargonText({ children, className }: JargonTextProps) {
  const text = typeof children === "string" ? children : "";
  if (!text) return null;
  const segments = scanJargon(text);
  return (
    <span className={className}>
      {segments.map((seg, i) =>
        seg.kind === "text" ? (
          <Fragment key={i}>{seg.text}</Fragment>
        ) : (
          <Explain key={i} term={seg.term} className="align-baseline">
            {seg.text}
          </Explain>
        ),
      )}
    </span>
  );
}
