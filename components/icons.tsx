import type { NavItem } from "@/lib/nav";

const paths: Record<NavItem["icon"], React.ReactNode> = {
  dashboard: (
    <>
      <rect x="3" y="3" width="7" height="9" rx="1.5" />
      <rect x="14" y="3" width="7" height="5" rx="1.5" />
      <rect x="14" y="12" width="7" height="9" rx="1.5" />
      <rect x="3" y="16" width="7" height="5" rx="1.5" />
    </>
  ),
  engine: (
    <>
      <rect x="6" y="6" width="12" height="12" rx="2" />
      <path d="M9 2v4M15 2v4M9 18v4M15 18v4M2 9h4M2 15h4M18 9h4M18 15h4" />
      <path d="M10 12h4" />
    </>
  ),
  research: (
    <>
      <circle cx="11" cy="11" r="7" />
      <path d="m20 20-3.5-3.5" />
    </>
  ),
  vuln: (
    <>
      <path d="M12 3 3 20h18L12 3Z" />
      <path d="M12 10v4M12 17.5v.01" />
    </>
  ),
  scanner: (
    <>
      <path d="m8 8-4 4 4 4M16 8l4 4-4 4M13.5 5l-3 14" />
    </>
  ),
  monitor: (
    <>
      <path d="M3 12h4l2.5-7 5 14L17 12h4" />
    </>
  ),
  database: (
    <>
      <ellipse cx="12" cy="5.5" rx="8" ry="3" />
      <path d="M4 5.5v13c0 1.7 3.6 3 8 3s8-1.3 8-3v-13M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3" />
    </>
  ),
  reports: (
    <>
      <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8l-5-5Z" />
      <path d="M14 3v5h5M9 13h6M9 17h6" />
    </>
  ),
};

export function NavIcon({ name, className }: { name: NavItem["icon"]; className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className ?? "h-5 w-5"}
      aria-hidden="true"
    >
      {paths[name]}
    </svg>
  );
}

export function Logo({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 32 32" className={className ?? "h-8 w-8"} aria-hidden="true">
      <defs>
        <linearGradient id="btc-g" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#22e0f5" />
          <stop offset="1" stopColor="#2e7bff" />
        </linearGradient>
      </defs>
      <path d="M16 2 28 7v9c0 7-5 12.5-12 14C9 28.500 4 23 4 16V7l12-5Z" fill="#060b18" stroke="url(#btc-g)" strokeWidth="1.8" />
      <path d="M12.500 10.500h5a2.300 2.300 0 0 1 0 4.600h-5m0 0h5.600a2.400 2.400 0 0 1 0 4.800h-5.600M12.500 10.500v9.400M14.800 8.800v1.700M14.800 19.900v1.700" fill="none" stroke="url(#btc-g)" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}
