import type { Metadata } from "next";
import { ComingSoon, PageHeader } from "@/components/ui";

export const metadata: Metadata = { title: "Intelligence Engine" };

export default function Page() {
  return (
    <>
      <PageHeader
        title="Intelligence Engine"
        subtitle="AI-assisted analysis of Bitcoin security data using NVIDIA Nemotron 3 Ultra."
      />
      <ComingSoon
        stage="engine"
        title="The Intelligence Engine"
        planned={[
          "Server-side calls to NVIDIA Nemotron 3 Ultra through the NVIDIA API (OpenAI-compatible), with the key kept in a server-only environment variable.",
          "Structured summaries and triage of advisories, releases and research notes.",
          "Per-user rate limits and caching so AI usage stays bounded.",
        ]}
      />
    </>
  );
}
