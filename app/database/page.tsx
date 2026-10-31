import type { Metadata } from "next";
import { ComingSoon, PageHeader } from "@/components/ui";

export const metadata: Metadata = { title: "Database" };

export default function Page() {
  return (
    <>
      <PageHeader
        title="Database"
        subtitle="The research database: stored intelligence, notes and scan results."
      />
      <ComingSoon
        stage="database"
        title="The Database"
        planned={[
          "Postgres (via the Vercel Marketplace) with typed migrations.",
          "Authentication and access control for the platform.",
          "Browsing and export of stored records.",
        ]}
      />
    </>
  );
}
