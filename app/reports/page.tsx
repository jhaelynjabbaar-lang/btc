import type { Metadata } from "next";
import { ComingSoon, PageHeader } from "@/components/ui";

export const metadata: Metadata = { title: "Reports" };

export default function Page() {
  return (
    <>
      <PageHeader title="Reports" subtitle="Generate security intelligence reports from stored research." />
      <ComingSoon
        stage="reports"
        title="Reports"
        planned={[
          "Generate Markdown reports from stored vulnerabilities, releases and research.",
          "Export and archive generated reports.",
          "A list of past reports shown on the dashboard.",
        ]}
      />
    </>
  );
}
