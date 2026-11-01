import { z } from "zod";

/** Admin control body. Reset accepts optional overrides for the three headline settings; everything else keeps the env/defaults. */
export const ControlBody = z.discriminatedUnion("action", [
  z.object({ action: z.literal("pause") }),
  z.object({ action: z.literal("resume") }),
  z.object({ action: z.literal("tick") }),
  z.object({
    action: z.literal("reset"),
    confirm: z.literal(true),
    starting_usd: z.number().min(1).max(100_000).optional(),
    fee_pct: z.number().min(0).max(5).optional(),
    slippage_pct: z.number().min(0).max(5).optional(),
  }),
]);
export type ControlInput = z.infer<typeof ControlBody>;
