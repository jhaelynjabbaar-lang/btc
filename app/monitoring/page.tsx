import type { Metadata } from "next";
import { ComingSoon, PageHeader } from "@/components/ui";

export const metadata: Metadata = { title: "Monitoring" };

export default function Page() {
  return (
    <>
      <PageHeader
        title="Monitoring"
        subtitle="Release and advisory monitoring for Bitcoin Core and related projects."
      />
      <ComingSoon
        stage="monitoring"
        title="Monitoring"
        planned={[
          "Scheduled checks (Vercel Cron) of bitcoin/bitcoin GitHub releases and tags.",
          "Scheduled checks of security advisory feeds.",
          "Alerts and a history of detected changes.",
        ]}
      />
    </>
  );
}
