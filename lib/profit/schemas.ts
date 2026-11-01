import { z } from "zod";

const watts = z.number().min(0).max(100_000);

/** Cost inputs form. null / blank = "not entered" (the cost stays unknown). Unknown keys are rejected. */
export const SettingsBody = z
  .object({
    electricity_usd_per_kwh: z.number().min(0).max(100).nullable(),
    default_watts_per_worker: watts.nullable(),
    worker_watts: z.record(z.uuid(), watts).default({}),
    pool_fee_pct_override: z.number().min(0).max(100).nullable(),
  })
  .strict();
export type SettingsInput = z.infer<typeof SettingsBody>;
