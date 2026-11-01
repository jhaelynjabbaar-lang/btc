import { z } from "zod";

/** Admin control body. Reset accepts an optional starting balance; everything else keeps the env/defaults. */
export const MemeControlBody = z.discriminatedUnion("action", [
  z.object({ action: z.literal("pause") }),
  z.object({ action: z.literal("resume") }),
  z.object({ action: z.literal("tick") }),
  z.object({ action: z.literal("reset"), confirm: z.literal(true), starting_usd: z.number().min(1).max(100_000).optional() }),
]);
export type MemeControlInput = z.infer<typeof MemeControlBody>;
