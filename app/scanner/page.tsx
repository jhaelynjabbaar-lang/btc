import type { Metadata } from "next";
import { ComingSoon, PageHeader } from "@/components/ui";

export const metadata: Metadata = { title: "Code Scanner" };

export default function Page() {
  return (
    <>
      <PageHeader
        title="Code Scanner"
        subtitle="AI-assisted static review of source code. Submitted code is never executed."
      />
      <ComingSoon
        stage="scanner"
        title="The Code Scanner"
        planned={[
          "Treats submitted code strictly as text: it is never executed, built or installed.",
          "Scans pasted code or files fetched from GitHub, with size and file-type limits.",
          "Findings grouped by severity with explanations and suggested fixes.",
        ]}
      />
    </>
  );
}
