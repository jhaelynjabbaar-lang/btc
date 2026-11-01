import { z } from "zod";
import { RESOURCE_EVENTS } from "./state";

/** Request validation for app/api/admin/cloud/*. Every body is a strict object (unknown keys are rejected). */

const httpsUrl = z
  .string()
  .max(300)
  .regex(/^https:\/\/[^\s]+$/, "must be an https URL");

export const RequestResourceBody = z.strictObject({
  provider_id: z.uuid(),
  label: z.string().trim().min(1).max(80),
  /** The provider's own id for a machine you already provisioned there. Optional; generated when absent. */
  instance_id: z
    .string()
    .trim()
    .min(1)
    .max(120)
    .regex(/^[A-Za-z0-9._:\-/]+$/)
    .optional(),
  request_kind: z.enum(["register_manual", "provision"]).default("register_manual"),
  capacity: z.record(z.string().max(40), z.union([z.string().max(80), z.number(), z.boolean()])).refine((o) => Object.keys(o).length <= 12, "too many keys").optional(),
  /** Hourly price in USD as published by the provider. Must come with the provider's source link, or the cost is recorded as unknown. */
  price: z.strictObject({ hourly_usd: z.number().min(0).max(10_000), source_url: httpsUrl, note: z.string().trim().max(200).optional() }).optional(),
  /** For adapters with a public catalogue: the offer whose published price should be used (server fetches it). */
  offer_id: z.string().trim().min(1).max(60).optional(),
});

export const ResourceActionBody = z.strictObject({
  action: z.enum(["approve", "reject", "activate", "start", "stop", "destroy"] satisfies readonly (typeof RESOURCE_EVENTS)[number][]),
  note: z.string().trim().max(200).optional(),
  /** The dashboard sends true only after the admin clicked through the confirmation. */
  confirm: z.literal(true),
});

export const SpendLimitBody = z
  .strictObject({
    scope: z.enum(["global", "provider"]),
    provider_id: z.uuid().optional(),
    /** 'hour' = the per-resource hourly cap; 'month' = the monthly cap for the scope. */
    period: z.enum(["hour", "month"]),
    limit_usd: z.number().min(0).max(1_000_000),
    confirm: z.literal(true),
  })
  .refine((b) => (b.scope === "provider") === (b.provider_id !== undefined), { message: "provider_id is required for scope 'provider' and not allowed for 'global'" });

export const ProviderAttestationBody = z.strictObject({
  written_permission_ref: z.string().trim().max(200).nullable().optional(),
  conditions_acknowledged: z.boolean(),
  confirm: z.literal(true),
});

export const KillSwitchBody = z.strictObject({ action: z.enum(["engage", "rearm"]), confirm: z.literal(true) });

export const OffersQuery = z.strictObject({
  provider: z.string().regex(/^[a-z0-9-]{2,40}$/),
  gpu_model: z.string().max(80).optional(),
  min_vram_gb: z.coerce.number().int().min(0).max(1024).optional(),
  region: z.string().max(40).optional(),
  max_hourly_usd: z.coerce.number().min(0).max(10_000).optional(),
  include_cpu: z.enum(["0", "1"]).optional(),
});
