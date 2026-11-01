import { z } from "zod";
import { FINDING_IDS, FINDING_STATUSES, ACTION_IDS } from "./actions";

/** Printable ASCII only: values come from a machine we do not control, so keep them boring (rendered with React escaping anyway). */
export const asciiText = (max: number) => z.string().max(max).regex(/^[\x20-\x7E]*$/, "printable ASCII only");

export const LIMITS = { pair: 2048, report: 16384, ack: 1024, admin: 4096 } as const;

export const PairBody = z.strictObject({
  code: z.string().min(8).max(32),
  agent_version: asciiText(16).optional(),
});

const Finding = z.strictObject({
  id: z.enum(FINDING_IDS),
  status: z.enum(FINDING_STATUSES),
  value: asciiText(120).default(""),
});

export const ReportBody = z.strictObject({
  kind: z.enum(["diagnostics", "actions", "error"]),
  agent_version: asciiText(16),
  host: z
    .strictObject({
      os_caption: asciiText(80).optional(),
      os_version: asciiText(40).optional(),
      sp: z.number().int().min(0).max(9).optional(),
      arch: z.enum(["x86", "x64"]).optional(),
      ram_mb: z.number().int().min(0).max(1_048_576).optional(),
      disk_free_mb: z.number().int().min(0).max(100_000_000).optional(),
      ie_version: asciiText(20).optional(),
      clr: asciiText(40).optional(),
      ps: asciiText(10).optional(),
    })
    .default({}),
  findings: z.array(Finding).max(40).default([]),
  errors: z.array(z.strictObject({ where: asciiText(40), message: asciiText(200) })).max(20).default([]),
  action_results: z
    .array(
      z.strictObject({
        suggestion_id: z.uuid().optional(),
        action_id: z.enum(ACTION_IDS),
        outcome: z.enum(["ran_ok", "ran_failed", "declined", "skipped"]),
        exit_code: z.number().int().min(-2147483648).max(2147483647).nullable().optional(),
      }),
    )
    .max(20)
    .default([]),
});
export type ReportInput = z.infer<typeof ReportBody>;

export const AckBody = z.strictObject({
  outcome: z.enum(["succeeded", "failed", "declined"]),
  exit_code: z.number().int().min(-2147483648).max(2147483647).nullable().optional(),
  note: asciiText(200).optional(),
});

// ---- admin
export const MintBody = z.strictObject({ label: asciiText(40).min(1) });
export const QueueBody = z.strictObject({ device_id: z.uuid().optional(), report_id: z.uuid().optional(), action_id: z.enum(ACTION_IDS), explanation: asciiText(300).min(1) });
export const DecideBody = z.strictObject({ decision: z.enum(["queue", "dismiss"]) });
export const AnalyzeBody = z.strictObject({ report_id: z.uuid() });
export const OfflineBody = z.strictObject({ code: z.string().min(8).max(40), label: asciiText(40).optional() });
export const RevokeBody = z.strictObject({ revoke: z.literal(true) });
