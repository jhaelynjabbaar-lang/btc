# Cloud providers (Phase 6)

The **Cloud** page (`/cloud`, admin only) is a control surface for renting compute *if the owner ever decides to*. As shipped it
**buys, provisions and contacts nothing**: there are no provider accounts, no provider API keys, and every spend cap is `0`.

## Read this first: the economics

Bitcoin mining is done by ASICs. A rented CPU or GPU hashes many orders of magnitude slower and less efficiently than an ASIC, so on
rented hardware **the rent will exceed anything you could earn**: expect a loss, and at CPU/GPU speeds you may never find a share worth a payout.
DediGPU's own terms say as much ("rarely profitable on rented hardware", quoted below). This repository publishes **no profitability or earnings figure,
because any such number would be invented**: the only numbers on the Cloud page are prices a provider published (with the link) and caps you typed.
This module exists so that, if you try it anyway, it is policy-checked, capped, approved by you and fully audited.

## Provider policy table (re-verified 2026-11-01 from each provider's own terms)

Stored in `public.cloud_providers` (migration `…140002_cloud_provider_seed.sql`) with the policy, link, verification date, a quote and notes.
Anything not stated by the provider's text is **not** assumed to be permitted.

| Provider | `mining_policy` | What the official text says | Source |
| --- | --- | --- | --- |
| Hetzner | **prohibited** | Terms §8.3: "The operation of applications for mining cryptocurrencies remains prohibited." Same in the Cloud-server and Dedicated-server agreements. No exception path. | [Terms](https://www.hetzner.com/legal/terms-and-conditions/), [Cloud server](https://www.hetzner.com/legal/cloud-server), [Dedicated](https://www.hetzner.com/legal/dedicated-server/) |
| Microsoft Azure | **prohibited** | Online Services Acceptable Use Policy: customer may not use the service "to mine cryptocurrency"; Azure Pass/Plan offers also forbid it. **The current text has no approval path.** (A Dec 2022 press report quoted "without Microsoft's prior written approval"; that qualifier is not in today's text, so Azure is treated as prohibited until Microsoft confirms otherwise in writing.) | [Online Services terms](https://www.microsoft.com/licensing/terms/product/ForOnlineServices/all), [Azure Pass](https://azure.microsoft.com/en-us/pricing/offers/azure-pass), [Dec 2022 report](https://www.theregister.com/off-prem/2022/12/15/microsoft-bans-mining-cryptocurrency-on-its-online-services/1352459) |
| TensorDock | **requires_written_permission** | AUP §4 (updated 2024-06-27): not allowed "cryptocurrency mining, without our express written permission". Blocked until you record a reference to that permission. None has been requested or obtained. | [AUP](https://docs.tensordock.com/legal-information/acceptable-use-policy-aup) |
| DediGPU | allowed_with_conditions | AUP §2 (effective 2026-09-02) lists "Cryptocurrency mining" as explicitly allowed, subject to the AUP's prohibitions and its terms. **Verification limit:** dedigpu.com could not be fetched from the build machine (connection reset / HTTP 500), so this wording is from the search index's copy of the official page. Re-read it in a browser before relying on it. | [AUP](https://dedigpu.com/legal/aup), [Terms](https://dedigpu.com/legal/terms) |
| BitCloudGPU | allowed_with_conditions | AUP v2.1 §5 "Ask first": sustained mining is "not prohibited, but tell us before you start". | [AUP](https://bitcloudgpu.com/legal/aup) |
| RentGPUPower | allowed_with_conditions | Prohibits mining on a machine "whose Host has not allowed it"; machines that allow it are marked "Mining allowed". | [Legal](https://rentgpupower.com/legal), [Guide](https://rentgpupower.com/guides/no-crypto-mining-on-rented-gpus) |
| Other (not verified) | **unknown** | Placeholder: any provider not listed. Blocked until its official terms are read and a real row is added. | n/a |

Policy semantics in code (`lib/cloud/policy.ts`, mirrored in SQL `cloud_policy_block`):

| Policy | Request a resource | Approve / activate / start |
| --- | --- | --- |
| `allowed` | yes | yes |
| `allowed_with_conditions` | yes | only after you click "I read the conditions and will follow them" (stored with a timestamp) |
| `requires_written_permission` | yes | only after you record a reference to the provider's written permission |
| `prohibited` | **no row is created** | **never** |
| `unknown` | **no row is created** | **never** |

`prohibited`/`unknown` cannot be unblocked from the UI or the API: the UI shows no attestation controls for them, and even if a permission reference or acknowledgement were recorded through the API, the policy check (`miningBlock` / SQL `cloud_policy_block`) ignores it for those two policies. Changing a policy requires a new, verified migration.

## How approval works

Every request creates a `cloud_resources` row in `pending_approval`. Nothing can act on it until you click **Approve**.

```
pending_approval ──approve──▶ approved ──activate──▶ provisioning ──▶ running ⇄ stopped
        └──reject──▶ rejected          └──destroy──▶ destroyed   (any active state → destroyed)
```

`rejected` and `destroyed` are terminal. Each transition runs in **one database transaction** (`public.cloud_transition`) that re-checks everything and
writes the `audit_log` row, so a state change without an audit entry is impossible. Entering `approved`, `provisioning` or `running` requires, in order:

1. the kill switch is not engaged;
2. the provider's policy lets it through (table above);
3. (not for `approve` itself) the resource's authorization is still `authorized`: an adapter never acts on something that was not approved;
4. the spend guard passes.

The estimated cost is **only** a price the provider published, entered with its https source link (or taken from a public catalogue the adapter read).
Without both it is recorded as **"unknown"**, and unknown cost can never pass the spend guard.

### Spend limits (`spend_limits` table)

* Caps: per-provider monthly, global monthly, and a per-resource hourly cap (global or per provider; the smallest applies).
* **Every cap defaults to 0**, and a missing or disabled cap is 0, so nothing can be approved until you set limits. Setting one needs a confirmation click and is audited with old and new value.
* The check is server-side (route → `preflight` → `cloud_transition`/`cloud_spend_check`, enforced again in SQL).
* Monthly spend is a **projection**: published hourly price × 730 h for each resource that is approved, provisioning or running. It is **not metered billing**;
  the provider's invoice is the truth, and idle or stopped-but-billed time at the provider is invisible to this app.

### Kill switch

"Stop all cloud resources" (two-step confirm): rejects all pending requests, marks all active resources `stopped` (approved-but-not-started become `destroyed`)
with approval revoked, and engages `cloud_controls.kill_switch_engaged`, which blocks approve/activate/start until you press **Re-arm** (also audited).
The database is updated first (fail-safe), then each resource's adapter `stop` is called. With the **manual adapter the app cannot power anything off
at the provider**; the result tells you which machines you must stop yourself.

## Adapters (`lib/cloud/adapters/`)

Interface: `listOffers, estimateCost, provision, start, stop, destroy, status`.

| Adapter | What it does |
| --- | --- |
| `manual` | Default for every provider. You provision the machine yourself at the provider and register it here. It never calls a provider; every operation returns instructions; `status` says the real state is unobservable. |
| `rentgpupower_catalog` | **Read-only.** One keyless public `GET https://rentgpupower.com/api/v1/compute/gpus` (documented as no-auth in the provider's [OpenAPI spec](https://rentgpupower.com/openapi.json)) to list offers and published prices. No auth header, no redirects, 8 s timeout, 1 MB cap. `provision/start/stop/destroy/status` throw. The catalogue has no "Mining allowed" flag, so offers say `not stated`: check the listing on the marketplace. |

Why only one read-only adapter: of the mining-permitting providers, only RentGPUPower documents a public keyless pricing API. DediGPU's API needs a bearer token; BitCloudGPU has none we could find; TensorDock requires written permission first.
**No adapter can provision** (that needs paid, authenticated calls). A provider API key, if one is ever added, must live in Vercel environment variables, server-side only, never in the repo or the browser.

## API (all admin-gated through `gateRoute`, zod-validated strict bodies, mutations need `"confirm": true`)

| Route | Purpose |
| --- | --- |
| `GET /api/admin/cloud` | Snapshot: providers, limits, resources, kill switch, recent audit |
| `POST /api/admin/cloud/resources` | Create a `pending_approval` request (blocked for prohibited/unknown providers) |
| `POST /api/admin/cloud/resources/[id]` | `approve / reject / activate / start / stop / destroy` |
| `PUT /api/admin/cloud/limits` | Set a cap (audited) |
| `PATCH /api/admin/cloud/providers/[id]` | Record permission reference / conditions acknowledgement |
| `POST /api/admin/cloud/kill-switch` | `engage` / `rearm` |
| `GET /api/admin/cloud/offers?provider=rentgpupower` | Read-only public price catalogue |

## Database

Additive migrations (applied to Supabase; RLS deny-all, service role only; `audit_log` stays append-only):
`20261101140001_cloud_module.sql` (policy/state columns, `cloud_controls`, RPCs `cloud_transition`, `cloud_request_resource`, `cloud_set_spend_limit`, `cloud_set_kill_switch`, `cloud_set_provider_attestation`, `cloud_spend_check`, `cloud_policy_block`)
and `20261101140002_cloud_provider_seed.sql` (provider registry above).

## What you must decide

1. **Whether to rent anything at all**, given the economics above.
2. **Spend limits**: all `0` today; nothing can be approved until you set them.
3. **Which provider**: allowed-with-conditions providers need your acknowledgement; TensorDock needs written permission you must request yourself; Hetzner and Azure are out.
4. **Re-read DediGPU's AUP in a browser** (it could not be fetched here) before acknowledging.
5. Everything is manual: you create and pay for any machine at the provider yourself.

## Tests

`npm test` (vitest): spend guard, policy block, approval state machine (including a parity test against the SQL transition table), preflight workflow, adapters and schemas.
