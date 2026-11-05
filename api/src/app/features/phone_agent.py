"""Operator routes of the phone-agent feature (CONTRACTS.md 6.L L15-L18, 9.3),
forwarded with _forward.forward to the phone-agent Lambda's `platform` hook.
Writes are audited by the forwarder (phone_agent_paused / phone_agent_resumed,
phone_agent_settings_changed)."""

from ._forward import forward

ROUTES: dict = {
    "GET /platform/tenants/{tenantId}/phone-agent": forward("phone-agent", "phone-agent.tenant.get"),
    "PUT /platform/tenants/{tenantId}/phone-agent": forward("phone-agent", "phone-agent.tenant.pause"),
    "GET /platform/phone-agent/settings": forward("phone-agent", "phone-agent.settings.get"),
    "PUT /platform/phone-agent/settings": forward("phone-agent", "phone-agent.settings.put"),
}
