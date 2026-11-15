"""Operator routes of the meta-ads feature (CONTRACTS.md 6.A A14-A17, 9.3),
forwarded with _forward.forward to the meta-ads Lambda's `platform` hook.
Writes are audited by the forwarder (meta_ads_settings_changed,
meta_ads_paused / meta_ads_resumed)."""

from ._forward import forward

ROUTES: dict = {
    "GET /platform/meta-ads/settings": forward("meta-ads", "meta-ads.settings.get"),
    "PUT /platform/meta-ads/settings": forward("meta-ads", "meta-ads.settings.put"),
    "PUT /platform/tenants/{tenantId}/meta-ads": forward("meta-ads", "meta-ads.tenant.pause"),
    "GET /platform/tenants/{tenantId}/meta-ads": forward("meta-ads", "meta-ads.tenant.get"),
}
