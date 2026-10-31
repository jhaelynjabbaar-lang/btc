"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { NAV_ITEMS } from "@/lib/nav";
import { Logo, NavIcon } from "./icons";

function isActive(pathname: string, href: string) {
  return href === "/" ? pathname === "/" : pathname === href || pathname.startsWith(`${href}/`);
}

function NavList({ pathname, onNavigate }: { pathname: string; onNavigate?: () => void }) {
  return (
    <nav aria-label="Primary" className="flex flex-col gap-1 px-3">
      {NAV_ITEMS.map((item) => {
        const active = isActive(pathname, item.href);
        return (
          <Link
            key={item.href}
            href={item.href}
            onClick={onNavigate}
            aria-current={active ? "page" : undefined}
            className={
              "group flex items-center gap-3 rounded-lg border px-3 py-2.5 text-sm transition-colors " +
              (active
                ? "border-electric/40 bg-electric/10 text-ink shadow-glow"
                : "border-transparent text-muted hover:border-line hover:bg-panel-hi hover:text-ink")
            }
          >
            <NavIcon
              name={item.icon}
              className={"h-5 w-5 shrink-0 " + (active ? "text-neon" : "text-faint group-hover:text-electric-hi")}
            />
            <span className="truncate">{item.label}</span>
          </Link>
        );
      })}
    </nav>
  );
}

function Brand() {
  return (
    <Link href="/" className="flex items-center gap-3">
      <Logo />
      <div className="leading-tight">
        <div className="text-base font-semibold tracking-wide text-ink">BTC</div>
        <div className="text-[11px] uppercase tracking-[0.18em] text-neon/80">Security Intelligence</div>
      </div>
    </Link>
  );
}

export function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  // The drawer is "open" only for the route it was opened on, so navigating closes it
  // without a setState-in-effect.
  const [openPath, setOpenPath] = useState<string | null>(null);
  const open = openPath === pathname;
  const setOpen = (value: boolean) => setOpenPath(value ? pathname : null);
  const current = NAV_ITEMS.find((i) => isActive(pathname, i.href));

  // Close the drawer on Escape.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpenPath(null);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  return (
    <div className="flex min-h-dvh">
      {/* Desktop sidebar */}
      <aside className="sticky top-0 hidden h-dvh w-64 shrink-0 flex-col border-r border-line bg-navy-900/80 backdrop-blur lg:flex">
        <div className="px-5 py-6">
          <Brand />
        </div>
        <NavList pathname={pathname} />
        <div className="mt-auto border-t border-line px-5 py-4 text-xs text-faint">
          <div className="font-mono">v0.1.0 · Stage 5</div>
          <div className="mt-1">Defensive security research only.</div>
        </div>
      </aside>

      {/* Mobile drawer */}
      {open && (
        <div className="fixed inset-0 z-40 lg:hidden" role="dialog" aria-modal="true" aria-label="Navigation">
          <button
            type="button"
            aria-label="Close navigation"
            className="absolute inset-0 bg-black/70"
            onClick={() => setOpen(false)}
          />
          <aside className="relative flex h-full w-72 max-w-[85vw] flex-col border-r border-line bg-navy-900">
            <div className="flex items-center justify-between px-5 py-5">
              <Brand />
              <button
                type="button"
                onClick={() => setOpen(false)}
                aria-label="Close navigation"
                className="rounded-md p-2 text-muted hover:bg-panel-hi hover:text-ink"
              >
                <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
                  <path d="M6 6l12 12M18 6 6 18" />
                </svg>
              </button>
            </div>
            <NavList pathname={pathname} onNavigate={() => setOpen(false)} />
          </aside>
        </div>
      )}

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-30 flex h-14 items-center gap-3 border-b border-line bg-void/80 px-4 backdrop-blur sm:px-6">
          <button
            type="button"
            onClick={() => setOpen(true)}
            aria-label="Open navigation"
            aria-expanded={open}
            className="-ml-1 rounded-md p-2 text-muted hover:bg-panel-hi hover:text-ink lg:hidden"
          >
            <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
              <path d="M4 7h16M4 12h16M4 17h16" />
            </svg>
          </button>
          <div className="min-w-0">
            <div className="truncate text-sm font-medium text-ink">{current?.label ?? "BTC"}</div>
            <div className="hidden truncate text-xs text-faint sm:block">{current?.description}</div>
          </div>
          <div className="ml-auto flex items-center gap-2 rounded-full border border-line bg-panel px-3 py-1 text-xs text-muted">
            <span className="h-1.5 w-1.5 rounded-full bg-neon shadow-[0_0_8px_var(--color-neon)]" aria-hidden="true" />
            Read-only preview
          </div>
        </header>
        <main className="bg-grid flex-1 px-4 py-6 sm:px-6 lg:px-8">
          <div className="mx-auto w-full max-w-7xl">{children}</div>
        </main>
      </div>
    </div>
  );
}
