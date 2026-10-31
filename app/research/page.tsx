import type { Metadata } from "next";
import { ComingSoon, PageHeader } from "@/components/ui";

export const metadata: Metadata = { title: "Research" };

export default function Page() {
  return (
    <>
      <PageHeader title="Research" subtitle="Notes, findings and investigations about Bitcoin security." />
      <ComingSoon
        stage="research"
        title="Research"
        planned={[
          "Create and organise research notes, tags and findings.",
          "Link findings to CVEs, advisories, releases and generated reports.",
          "Backed by the research database.",
        ]}
      />
    </>
  );
}
