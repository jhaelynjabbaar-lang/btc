/** Auth configuration helpers. No secrets are read into variables beyond presence checks. */

export function authConfigured(): boolean {
  return Boolean(process.env.AUTH_SECRET && process.env.AUTH_GITHUB_ID && process.env.AUTH_GITHUB_SECRET);
}

/** GitHub logins allowed to sign in (case-insensitive). Defaults to the project owner. */
export function adminLogins(): string[] {
  const raw = process.env.ADMIN_GITHUB_LOGINS?.trim() || "jhaelynjabbaar-lang";
  return raw
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

export function isAdminLogin(login: string | null | undefined): boolean {
  return Boolean(login) && adminLogins().includes(String(login).toLowerCase());
}

/** Only same-site relative paths are allowed as post-login destinations. */
export function safeNext(next: string | null | undefined): string {
  if (!next || !next.startsWith("/") || next.startsWith("//") || next.includes("\\")) return "/";
  return next.slice(0, 500);
}
