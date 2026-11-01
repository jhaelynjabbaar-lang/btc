-- BTC Network AI: Phase 6 — seed the cloud provider registry with facts re-verified on 2026-11-01 from each provider's own
-- terms (policy_url) — the full table with links is in docs/cloud.md. Nothing here grants a permission that the
-- provider's text does not grant. Idempotent: re-running updates the same rows by slug.
-- mining_allowed_quote / verified_at (the Phase 2 "mining is allowed" evidence pair) are intentionally left NULL for every
-- provider: none of them states a clean, unconditional permission, and the stricter evidence lives in policy_quote.

insert into public.cloud_providers (name, slug, mining_policy, policy_url, policy_quote, last_verified_on, notes, adapter, pricing_url) values
(
  'Hetzner', 'hetzner', 'prohibited',
  'https://www.hetzner.com/legal/terms-and-conditions/',
  'Terms and Conditions §8.3: "The operation of applications for mining cryptocurrencies remains prohibited. These include, but are not limited to, mining, farming and plotting of cryptocurrencies." Also prohibited in the Cloud server SLA (https://www.hetzner.com/legal/cloud-server) and the Dedicated server agreement (https://www.hetzner.com/legal/dedicated-server/): "Operating applications that are used to mine crypto currencies".',
  '2026-11-01',
  'No exception or permission path is stated. Hetzner may lock the account. Blocked from provisioning.',
  'manual', null
),
(
  'Microsoft Azure', 'azure', 'prohibited',
  'https://www.microsoft.com/licensing/terms/product/ForOnlineServices/all',
  'Universal License Terms for Online Services, Acceptable Use Policy (current text read 2026-11-01): Customer may not use an Online Service "to mine cryptocurrency". Azure Pass and Azure Plan offers: "You will not facilitate, engage in, or participate in any use of Azure services for crypto currency mining" (https://azure.microsoft.com/en-us/pricing/offers/azure-pass). Azure Dev Box: "You may not use the service for sustained distributed computing or digital asset transaction validation workloads" (https://www.microsoft.com/licensing/terms/en-US/productoffering/microsoftazure/mosa).',
  '2026-11-01',
  'The current official text states no approval path. Press coverage of the December 2022 version quoted "without Microsoft''s prior written approval" (https://www.theregister.com/off-prem/2022/12/15/microsoft-bans-mining-cryptocurrency-on-its-online-services/1352459), but that qualifier is not in the text read today. Treated as prohibited; blocked from provisioning. Only a written confirmation from Microsoft would change this.',
  'manual', null
),
(
  'TensorDock', 'tensordock', 'requires_written_permission',
  'https://docs.tensordock.com/legal-information/acceptable-use-policy-aup',
  'Acceptable Use Policy §4 (last updated June 27, 2024): "We do not allow data or activity on TensorDock that is: ... cryptocurrency mining, without our express written permission".',
  '2026-11-01',
  'Blocked until the owner records a reference to TensorDock''s express written permission on this provider. No permission has been requested or obtained.',
  'manual', null
),
(
  'DediGPU', 'dedigpu', 'allowed_with_conditions',
  'https://dedigpu.com/legal/aup',
  'Acceptable use policy §2 "What is allowed, explicitly" (effective 2 September 2026): "Cryptocurrency mining. It is rarely profitable on rented hardware, but it is not our business to stop you." Conditions: the AUP §3 prohibitions (attacks, malware, fraud, spam, illegal content, harming other tenants/hardware) and the terms of service (https://dedigpu.com/legal/terms).',
  '2026-11-01',
  'VERIFICATION LIMIT: dedigpu.com could not be fetched directly from the build machine (connection reset / HTTP 500), so this wording comes from the search index''s copy of the official page; re-read the page in a browser before relying on it. Prepaid crypto balance, monthly terms, auto-renewal. Its catalogue API (https://dedigpu.com/api) needs a bearer token, so no keyless pricing adapter is possible.',
  'manual', 'https://dedigpu.com/pricing'
),
(
  'BitCloudGPU', 'bitcloudgpu', 'allowed_with_conditions',
  'https://bitcloudgpu.com/legal/aup',
  'Acceptable Use Policy v2.1 (revised 2026-08-24) §5 "Ask first": "Not prohibited, but tell us before you start. ... Sustained cryptocurrency mining. The concern is thermal and electrical, not ideological: a rack held at maximum power draw indefinitely affects the machines beside it, and some suites can take it while others cannot."',
  '2026-11-01',
  'Condition: tell BitCloudGPU before you start sustained mining (record that notice as a conditions acknowledgement here). No public pricing API found (https://bitcloudgpu.com/api returns 404), so manual adapter only.',
  'manual', null
),
(
  'RentGPUPower', 'rentgpupower', 'allowed_with_conditions',
  'https://rentgpupower.com/legal',
  'Terms/Acceptable Use: it is prohibited to "Mine cryptocurrency on a machine whose Host has not allowed it (machines that allow it are marked "Mining allowed"; the compute API never accepts mining)". Guide: https://rentgpupower.com/guides/no-crypto-mining-on-rented-gpus.',
  '2026-11-01',
  'Only on marketplace listings marked "Mining allowed"; the public catalogue endpoint does not expose that flag, so each listing must be checked on the marketplace. The compute API never accepts mining. Read-only public catalogue adapter available (GET /api/v1/compute/gpus, documented in https://rentgpupower.com/openapi.json, no key).',
  'rentgpupower_catalog', 'https://rentgpupower.com/pricing'
),
(
  'Other provider (not verified)', 'other-unverified', 'unknown',
  null, null, null,
  'Placeholder for any provider not listed above. Its mining policy is UNKNOWN, so it is blocked from provisioning until its official terms are read and a real row is added with the policy URL and verification date.',
  'manual', null
)
on conflict (slug) do update set
  name = excluded.name, mining_policy = excluded.mining_policy, policy_url = excluded.policy_url,
  policy_quote = excluded.policy_quote, last_verified_on = excluded.last_verified_on, notes = excluded.notes,
  adapter = excluded.adapter, pricing_url = excluded.pricing_url;
