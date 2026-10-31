import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { PageHeader, Panel } from "@/components/ui";
import { actorForPage } from "@/lib/auth/access";
import { adminLogins, authConfigured, safeNext } from "@/lib/auth/config";

export const metadata: Metadata = { title: "Sign in" };
export const dynamic = "force-dynamic";

type SP = Promise<{ [k: string]: string | string[] | undefined }>;
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

export default async function SignInPage({ searchParams }: { searchParams: SP }) {
  const sp = await searchParams;
  const next = safeNext(one(sp.next));
  const error = one(sp.error);
  const configured = authConfigured();

  if (configured) {
    const actor = await actorForPage();
    if (actor.allowed) redirect(next);
  }

  async function login() {
    "use server";
    const { signIn } = await import("@/lib/auth");
    await signIn("github", { redirectTo: next });
  }

  return (
    <>
      <PageHeader title="Sign in" subtitle="Access to the AI engine, code scanner, database and monitoring is limited to allow-listed GitHub accounts." />
      <div className="mx-auto max-w-xl">
        <Panel title={configured ? "GitHub sign-in" : "Authentication not configured yet"}>
          {error && (
            <div className="mb-4 rounded-lg border border-danger/40 bg-danger/10 p-3 text-sm text-danger" role="alert">
              {error === "AccessDenied"
                ? "That GitHub account is not on the allowlist."
                : "Sign-in failed. Try again."}
            </div>
          )}
          {configured ? (
            <form action={login}>
              <button type="submit" className="w-full rounded-lg bg-gradient-to-r from-electric to-neon px-5 py-3 text-sm font-semibold text-void">
                Continue with GitHub
              </button>
              <p className="mt-3 text-xs text-faint">
                Allowed accounts: {adminLogins().join(", ")}. Sessions last 8 hours.
              </p>
            </form>
          ) : (
            <div className="space-y-3 text-sm text-muted">
              <p>
                Sign-in is not available because the GitHub OAuth app credentials have not been provided. Until they are, protected
                features fall back to Vercel deployment protection (they only work on <span className="font-mono text-xs">*.vercel.app</span> hosts
                behind Vercel SSO, or on localhost).
              </p>
              <p className="text-xs text-faint">
                Owner setup: create a GitHub OAuth app, then set <span className="font-mono">AUTH_SECRET</span>,{" "}
                <span className="font-mono">AUTH_GITHUB_ID</span>, <span className="font-mono">AUTH_GITHUB_SECRET</span> (and optionally{" "}
                <span className="font-mono">ADMIN_GITHUB_LOGINS</span>) in Vercel. Callback URL:{" "}
                <span className="font-mono">https://&lt;your-domain&gt;/api/auth/callback/github</span>.
              </p>
            </div>
          )}
        </Panel>
      </div>
    </>
  );
}
