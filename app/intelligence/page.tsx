import type { Metadata } from "next";
import { AccessDisabled } from "@/components/db-states";
import { ResearchConsole } from "@/components/research-console";
import { PageHeader } from "@/components/ui";
import { requirePageAccess } from "@/lib/auth/access";

export const metadata: Metadata = { title: "Intelligence Engine" };

type SP = Promise<{ [k: string]: string | string[] | undefined }>;
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

export default async function Page({ searchParams }: { searchParams: SP }) {
  const sp = await searchParams;
  const rawNext = new URLSearchParams(Object.entries(sp).flatMap(([k, v]) => (typeof v === "string" ? [[k, v]] : []))).toString();
  const access = await requirePageAccess(`/intelligence${rawNext ? `?${rawNext}` : ""}`);
  const q = one(sp.q)?.slice(0, 4000);
  const mode: "chat" | "report" = one(sp.mode) === "report" ? "report" : "chat";
  const auto = one(sp.auto) === "1" && q ? { q, mode } : null;
  return (
    <>
      <PageHeader
        eyebrow="NVIDIA Nemotron 3 Ultra · grounded"
        title="Intelligence Engine"
        subtitle="Ask Bitcoin security questions. Each answer is grounded on sources retrieved live from NVD, GitHub advisories and bitcoincore.org; claims without a retrieved source can't be marked VERIFIED."
      />
      {"blocked" in access ? (
        <AccessDisabled />
      ) : (
      <ResearchConsole
        key={auto ? `${auto.mode}:${auto.q}` : "blank"}
        initialQuestion={auto?.q}
        initialMode={auto?.mode}
      />
      )}
    </>
  );
}
