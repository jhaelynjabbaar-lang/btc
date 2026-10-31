import type { Metadata } from "next";
import { ScannerConsole } from "@/components/scanner-console";
import { PageHeader } from "@/components/ui";

export const metadata: Metadata = { title: "Code Scanner" };

export default function Page() {
  return (
    <>
      <PageHeader
        eyebrow="Static analysis · never executes code"
        title="Code Scanner"
        subtitle="Paste or upload source code for AI-assisted security review, alongside a deterministic pattern pre-scan. Focused on key handling, randomness, crypto misuse, injection and secrets."
      />
      <ScannerConsole />
    </>
  );
}
