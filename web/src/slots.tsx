import { ComponentType, Suspense, lazy } from "react";
import { CONSOLE_SLOTS, type ConsoleSlotId, type FeatureKey } from "./contracts";
import type { Features } from "./types";

/** Each slot's feature-owned component (CONTRACTS.md 8.3). A missing id fails typecheck. */
// `any`: each slot has its own props (CONTRACTS.md 8.3).
export const SLOT_LOADERS: Record<ConsoleSlotId, () => Promise<{ default: ComponentType<any> }>> = {
  "tenant.integrations.metaAds": () => import("./features/meta-ads/MetaAdsTenantSection"),
  "tenant.integrations.googleBusiness": () => import("./features/google-business/GoogleBusinessTenantSection"),
  "tenant.integrations.phoneAgent": () => import("./features/phone-agent/PhoneAgentTenantSection"),
  "tenant.website.siteBuilder": () => import("./features/site-builder/SiteBuilderSection"),
  "tenant.offboard.personalliggare": () => import("./features/personalliggare/ExportLedgerSection"),
  "settings.metaAds": () => import("./features/meta-ads/MetaAdsSettingsCard"),
  "settings.phoneAgent": () => import("./features/phone-agent/PhoneAgentSettingsCard"),
};

const LAZY = Object.fromEntries(
  Object.entries(SLOT_LOADERS).map(([id, load]) => [id, lazy(load)]),
) as Record<string, ComponentType<Record<string, unknown>>>;

/** True when the slot's feature (any of, for a list) is on; a slot without a feature always shows. */
export function slotOn(id: ConsoleSlotId, features: Features = {}): boolean {
  const need = CONSOLE_SLOTS[id].feature;
  if (need === null) return true;
  return (Array.isArray(need) ? need : [need]).some((k: FeatureKey) => !!features[k]);
}

export function Slot({ id, features, props = {} }: { id: ConsoleSlotId; features?: Features; props?: Record<string, unknown> }) {
  if (!slotOn(id, features)) return null;
  const C = LAZY[id];
  return <Suspense fallback={null}><C {...props} /></Suspense>;
}
