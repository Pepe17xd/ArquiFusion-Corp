import type { SVGProps } from "react";

export function BrandMark(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 48 48" fill="none" aria-hidden="true" {...props}>
      <path d="M24 3.8 41.3 13.9v20.2L24 44.2 6.7 34.1V13.9L24 3.8Z" stroke="currentColor" strokeOpacity=".42" strokeWidth="1.2"/>
      <path d="M24 11.1 35.2 17.6v12.8L24 36.9 12.8 30.4V17.6L24 11.1Z" stroke="currentColor" strokeWidth="1.7"/>
      <path d="M24 11.1v9.1m11.2-2.6-7.9 4.6m7.9 8.2-7.9-4.6M24 36.9v-9.1m-11.2 2.6 7.9-4.6m-7.9-8.2 7.9 4.6" stroke="currentColor" strokeWidth="1.35" strokeLinecap="round"/>
      <path d="m24 17.2 5.9 3.4v6.8L24 30.8l-5.9-3.4v-6.8l5.9-3.4Z" fill="currentColor" fillOpacity=".16" stroke="currentColor" strokeWidth="1.4"/>
      <circle cx="24" cy="24" r="2.25" fill="currentColor"/>
      <circle cx="24" cy="11.1" r="1.8" fill="currentColor"/><circle cx="35.2" cy="17.6" r="1.8" fill="currentColor"/>
      <circle cx="35.2" cy="30.4" r="1.8" fill="currentColor"/><circle cx="24" cy="36.9" r="1.8" fill="currentColor"/>
      <circle cx="12.8" cy="30.4" r="1.8" fill="currentColor"/><circle cx="12.8" cy="17.6" r="1.8" fill="currentColor"/>
    </svg>
  );
}

export function BrandLockup({ compact = false }: { compact?: boolean }) {
  return (
    <div className={"brand-lockup" + (compact ? " compact" : "")}>
      <BrandMark className="brand-mark" />
      <span className="brand-wordmark">ARQUIFUSION</span>
    </div>
  );
}
