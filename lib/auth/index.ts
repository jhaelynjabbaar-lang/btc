import "server-only";
import { DrizzleAdapter } from "@auth/drizzle-adapter";
import NextAuth from "next-auth";
import GitHub from "next-auth/providers/github";
import { getDb } from "@/lib/db/client";
import { accounts, sessions, users, verificationTokens } from "@/lib/db/schema";
import { isAdminLogin } from "./config";

/**
 * Auth.js v5, GitHub provider, allowlist of GitHub logins (ADMIN_GITHUB_LOGINS).
 * Sessions are JWT (works without a database). When DATABASE_URL is set, the Drizzle adapter additionally
 * persists users/accounts in Postgres. Nothing here runs unless the AUTH_* variables are set (see authConfigured()).
 */
const db = getDb();

export const { handlers, auth, signIn, signOut } = NextAuth({
  providers: [
    GitHub({
      clientId: process.env.AUTH_GITHUB_ID,
      clientSecret: process.env.AUTH_GITHUB_SECRET,
    }),
  ],
  adapter: db
    ? DrizzleAdapter(db, {
        usersTable: users,
        accountsTable: accounts,
        sessionsTable: sessions,
        verificationTokensTable: verificationTokens,
      })
    : undefined,
  session: { strategy: "jwt", maxAge: 8 * 60 * 60 },
  pages: { signIn: "/signin", error: "/signin" },
  trustHost: true,
  callbacks: {
    // Reject anyone who is not on the allowlist before a session is created.
    signIn({ profile }) {
      return isAdminLogin((profile as { login?: string } | undefined)?.login);
    },
    jwt({ token, profile }) {
      const login = (profile as { login?: string } | undefined)?.login;
      if (login) token.login = login;
      return token;
    },
    session({ session, token }) {
      (session.user as { login?: string }).login = typeof token.login === "string" ? token.login : undefined;
      return session;
    },
  },
});
