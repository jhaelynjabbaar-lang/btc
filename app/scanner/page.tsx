import type { Metadata } from "next";
import { AccessDisabled } from "@/components/db-states";
import { ScannerConsole } from "@/components/scanner-console";
import { PageHeader } from "@/components/ui";
import { requirePageAccess } from "@/lib/auth/access";

export const metadata: Metadata = { title: "Code Scanner" };
export const dynamic = "force-dynamic";

export default async function Page() {
  const access = await requirePageAccess("/scanner");
  return (
    <>
      <PageHeader
        eyebrow="Static analysis · never executes code"
        title="Code Scanner"
        subtitle="Paste or upload source code for AI-assisted security review, alongside a deterministic pattern pre-scan. Focused on key handling, randomness, crypto misuse, injection and secrets."
      />
      {"blocked" in access ? <AccessDisabled /> : <ScannerConsole />}
    </>
  );
}
