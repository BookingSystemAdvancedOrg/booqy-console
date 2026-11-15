"""Operator route of the personalliggare feature (CONTRACTS.md 6.H H9, 9.3),
forwarded with _forward.forward to the personalliggare Lambda's `platform`
hook. Every export is audited (`staff_ledger_exported`), and it works for
offboarded tenants: the ledger keeps its own rows after the purge."""

from ._forward import forward

ROUTES: dict = {
    "GET /platform/tenants/{tenantId}/personalliggare/export": forward("personalliggare", "personalliggare.export"),
}
