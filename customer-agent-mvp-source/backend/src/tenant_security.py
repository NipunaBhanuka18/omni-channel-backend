import re
import secrets
import unicodedata

from security import RequestError


EMAIL_PATTERN = re.compile(r"^[^\s@]+@[^\s@]+\.[^\s@]+$")
SLUG_PATTERN = re.compile(r"[^a-z0-9]+")


def normalized_email(value: str) -> str:
    email = str(value or "").strip().lower()
    if len(email) > 254 or not EMAIL_PATTERN.fullmatch(email):
        raise RequestError("A valid work email is required")
    return email


def company_slug(value: str) -> str:
    plain = unicodedata.normalize("NFKD", str(value or "")).encode("ascii", "ignore").decode().lower()
    slug = SLUG_PATTERN.sub("-", plain).strip("-")[:46]
    if len(slug) < 2:
        slug = "company"
    return f"{slug}-{secrets.token_hex(3)}"


def tenant_id() -> str:
    return f"ten_{secrets.token_hex(8)}"


def validate_role(value: str) -> str:
    role = str(value or "").upper()
    if role not in ("COMPANY_ADMIN", "LIVE_AGENT"):
        raise RequestError("Role must be COMPANY_ADMIN or LIVE_AGENT")
    return role
