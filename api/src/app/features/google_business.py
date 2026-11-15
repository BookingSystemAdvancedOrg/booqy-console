"""Operator route of the google-business feature (CONTRACTS.md 6.D D11, 9.3),
forwarded with _forward.forward to the google-business Lambda's `platform`
hook. Read only, so nothing is audited."""

from ._forward import forward

ROUTES: dict = {
    "GET /platform/tenants/{tenantId}/google-business": forward("google-business", "google-business.tenant.get"),
}
