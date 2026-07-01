import { ChevronRight } from "lucide-react";

/**
 * Standard expand/collapse affordance: chevron rotates 90° when open (accordion style).
 * Use framed={true} for section headers; framed={false} inside an existing icon button.
 */
export function AccordionChevron({
  open,
  size = 16,
  framed = true,
  className = "",
}: {
  open: boolean;
  size?: number;
  framed?: boolean;
  className?: string;
}) {
  if (!framed) {
    return (
      <span className={`inline-flex items-center justify-center${className ? ` ${className}` : ""}`.trim()}>
        <ChevronRight
          size={size}
          strokeWidth={2.25}
          className={`shrink-0 text-current transition-transform duration-200 ease-out ${open ? "rotate-90" : "rotate-0"}`}
          aria-hidden
        />
      </span>
    );
  }

  const outerClass =
    `inline-flex h-8 w-8 items-center justify-center rounded-lg border border-white/10 bg-white/[0.04] shrink-0 text-slate-400 transition-colors hover:border-accent/35 hover:text-accent${className ? ` ${className}` : ""}`.trim();
  const iconClass = `shrink-0 transition-transform duration-200 ease-out text-current ${open ? "rotate-90" : "rotate-0"}`;

  return (
    <span className={outerClass} aria-hidden>
      <ChevronRight size={size} strokeWidth={2.25} className={iconClass} aria-hidden />
    </span>
  );
}
