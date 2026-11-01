export type NavItem = {
  href: string;
  label: string;
  description: string;
  icon: "dashboard" | "engine" | "research" | "vuln" | "scanner" | "monitor" | "database" | "reports" | "workers" | "cloud" | "ai" | "financials";
};

export const NAV_ITEMS: NavItem[] = [
  { href: "/", label: "Dashboard", description: "Operations overview", icon: "dashboard" },
  { href: "/intelligence", label: "Intelligence Engine", description: "NVIDIA Nemotron research engine", icon: "engine" },
  { href: "/research", label: "Research", description: "Research notes and findings", icon: "research" },
  { href: "/vulnerabilities", label: "Vulnerabilities", description: "CVE and advisory intelligence", icon: "vuln" },
  { href: "/scanner", label: "Code Scanner", description: "Static AI code review", icon: "scanner" },
  { href: "/monitoring", label: "Monitoring", description: "Release and advisory monitoring", icon: "monitor" },
  { href: "/workers", label: "Workers", description: "Agent fleet and enrollment", icon: "workers" },
  { href: "/repair", label: "PC Repair", description: "Windows 7 repair helper: pairing, reports, suggestions", icon: "workers" },
  { href: "/cloud", label: "Cloud", description: "Providers, approvals and spend limits", icon: "cloud" },
  { href: "/financials", label: "Financials", description: "Estimated vs confirmed profitability (admin)", icon: "financials" },
  { href: "/ai", label: "AI Control", description: "Recommendations from NVIDIA Nemotron (admin approves)", icon: "ai" },
  { href: "/database", label: "Database", description: "Research database", icon: "database" },
  { href: "/reports", label: "Reports", description: "Security report generator", icon: "reports" },
];
