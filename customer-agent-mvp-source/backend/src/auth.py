from dataclasses import dataclass

from security import RequestError


@dataclass(frozen=True)
class Principal:
    user_id: str
    tenant_id: str
    role: str
    email: str
    name: str


def require_principal(event: dict, allowed_roles: tuple[str, ...]) -> Principal:
    claims = (((event.get("requestContext") or {}).get("authorizer") or {}).get("jwt") or {}).get("claims") or {}
    tenant_id = claims.get("custom:tenant_id") or claims.get("tenant_id")
    role = claims.get("custom:role") or claims.get("role")
    user_id = claims.get("sub")
    if not tenant_id or not role or not user_id:
        raise RequestError("Authenticated tenant identity is required", 401)
    if role not in allowed_roles:
        raise RequestError("You do not have permission for this action", 403)
    return Principal(user_id=user_id, tenant_id=tenant_id, role=role,
                     email=claims.get("email", ""), name=claims.get("name") or claims.get("email", "User"))

