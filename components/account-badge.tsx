import { authConfigured } from "@/lib/auth/config";

/** Server component: shows the signed-in GitHub login + sign-out, or a sign-in link when auth is configured. */
export async function AccountBadge() {
  if (!authConfigured()) return null;
  const { auth } = await import("@/lib/auth");
  const session = await auth();
  const login = (session?.user as { login?: string } | undefined)?.login;
  if (!login) {
    return (
      <a href="/signin" className="rounded-full border border-electric/40 bg-electric/10 px-3 py-1 text-xs text-electric-hi hover:bg-electric/20">
        Sign in
      </a>
    );
  }
  async function out() {
    "use server";
    const { signOut: so } = await import("@/lib/auth");
    await so({ redirectTo: "/" });
  }
  return (
    <form action={out} className="flex items-center gap-2 text-xs text-muted">
      <span className="hidden font-mono text-ink sm:inline">@{login}</span>
      <button type="submit" className="rounded-full border border-line px-3 py-1 hover:text-ink">Sign out</button>
    </form>
  );
}
