"""Forward an operator route to a feature's API Lambda with the `platform`
hook (CONTRACTS.md 9.1 and 9.3) and audit the writes."""

import json

from botocore.exceptions import ClientError

from ..contracts import CONSOLE_FORWARD_OPS
from ..core import ApiError, client, env, log, write_audit

# Platform-wide writes (no tenantId in the path) are audited here.
PLATFORM_AUDIT_TENANT = "PLATFORM"


def _function_name(feature_id: str) -> str:
    stage = env("ENVIRONMENT", "dev")
    return f"{'' if stage == 'prod' else stage + '-'}{feature_id}:live"


def _audit_action(op: str, body: dict) -> str | None:
    action = CONSOLE_FORWARD_OPS[op]["audit"]
    if action and "/" in action:  # "on/off" pair, chosen by the request's `paused`
        on, off = action.split("/")
        return on if body.get("paused") else off
    return action


def forward(feature_id: str, op: str):
    if CONSOLE_FORWARD_OPS[op]["target"] != feature_id:
        raise ValueError(f"{op} does not belong to {feature_id}")

    def handle(req) -> tuple[int, dict]:
        tenant_id = req.path.get("tenantId")
        payload = {"hook": "platform", "hookVersion": 1, "tenantId": tenant_id, "op": op,
                   "body": req.body, "query": req.query,
                   "operator": {"sub": req.claims.get("sub"), "email": req.claims.get("email")}}
        try:
            response = client("lambda").invoke(FunctionName=_function_name(feature_id), InvocationType="RequestResponse",
                                  Payload=json.dumps(payload).encode("utf-8"))
            result = json.loads(response["Payload"].read() or b"null")
        except ClientError as e:
            if e.response.get("Error", {}).get("Code") == "ResourceNotFoundException":
                raise ApiError(404, "not_found", "This feature is not deployed in this environment") from None
            log.exception("platform hook %s failed", op)
            raise ApiError(503, "feature_unavailable", "The feature did not answer; try again") from None
        except Exception:  # noqa: BLE001 - timeout or non-JSON: the feature is unavailable
            log.exception("platform hook %s failed", op)
            raise ApiError(503, "feature_unavailable", "The feature did not answer; try again") from None
        if response.get("FunctionError") or not isinstance(result, dict):
            log.info(json.dumps({"platformHookError": op, "feature": feature_id}))
            raise ApiError(503, "feature_unavailable", "The feature did not answer; try again")
        if result.get("ok") is False:
            extra = {"fields": {result["field"]: result["code"]}} if result.get("field") else {}
            raise ApiError(int(result.get("status") or 400), str(result.get("code") or "rejected"), **extra)
        status, body = int(result.get("status") or 200), result.get("body") or {}
        action = _audit_action(op, req.body or {})
        if action and status < 400:
            write_audit(tenant_id or PLATFORM_AUDIT_TENANT, action, req.actor, {"op": op})
        return status, body

    return handle
