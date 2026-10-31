import { NextResponse } from "next/server";
import { handlers } from "@/lib/auth";
import { authConfigured } from "@/lib/auth/config";

export const dynamic = "force-dynamic";

const off = () =>
  NextResponse.json(
    { error: "auth_not_configured", message: "Set AUTH_SECRET, AUTH_GITHUB_ID and AUTH_GITHUB_SECRET to enable sign-in." },
    { status: 503 },
  );

export async function GET(request: Request) {
  return authConfigured() ? handlers.GET(request as never) : off();
}
export async function POST(request: Request) {
  return authConfigured() ? handlers.POST(request as never) : off();
}
