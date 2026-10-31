import type { Metadata } from "next";
import { ResearchConsole } from "@/components/research-console";
import { PageHeader } from "@/components/ui";

export const metadata: Metadata = { title: "Intelligence Engine" };

type SP = Promise<{ [k: string]: string | string[] | undefined }>;
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

export default async function Page({ searchParams }: { searchParams: SP }) {
  const sp = await searchParams;
  const q = one(sp.q)?.slice(0, 1000);
  const mode: "chat" | "report" = one(sp.mode) === "report" ? "report" : "chat";
  const auto = one(sp.auto) === "1" && q ? { q, mode } : null;
  return (
    <>
      <PageHeader
        eyebrow="NVIDIA Nemotron 3 Ultra · grounded"
        title="Intelligence Engine"
        subtitle="Ask Bitcoin security questions. Each answer is grounded on sources retrieved live from NVD, GitHub advisories and bitcoincore.org; claims without a retrieved source can't be marked VERIFIED."
      />
      {/* key forces a fresh console when a different preset is launched */}
      <ResearchConsole
        key={auto ? `${auto.mode}:${auto.q}` : "blank"}
        initialQuestion={auto?.q}
        initialMode={auto?.mode}
      />
    </>
  );
}
