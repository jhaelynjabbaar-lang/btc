import type { Metadata } from "next";
import { ComingSoon, PageHeader } from "@/components/ui";

export const metadata: Metadata = { title: "Vulnerabilities" };

export default function Page() {
  return (
    <>
      <PageHeader
        title="Vulnerabilities"
        subtitle="CVE and advisory intelligence relevant to Bitcoin software."
      />
      <ComingSoon
        stage="vulnerabilities"
        title="Vulnerability intelligence"
        planned={[
          "Ingest the NVD CVE API 2.0 and GitHub Security Advisories.",
          "Ingest Bitcoin Core security advisories from bitcoincore.org.",
          "Searchable, deduplicated vulnerability records with severity and affected-version data.",
        ]}
      />
    </>
  );
}
