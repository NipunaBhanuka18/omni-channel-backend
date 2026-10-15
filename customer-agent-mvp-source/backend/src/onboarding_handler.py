import hashlib
import hmac
import json
import logging
import os
import secrets
import time
import uuid

import boto3
from botocore.exceptions import ClientError

from security import RequestError, parse_json_body
from tenant_security import company_slug, normalized_email, tenant_id


log = logging.getLogger()
log.setLevel(logging.INFO)
dynamodb = boto3.resource("dynamodb")
registrations = dynamodb.Table(os.environ["ONBOARDING_REGISTRATIONS_TABLE"])
tenants = dynamodb.Table(os.environ["TENANTS_TABLE"])
slugs = dynamodb.Table(os.environ["TENANT_SLUGS_TABLE"])
members = dynamodb.Table(os.environ["TENANT_MEMBERS_TABLE"])
live_agents = dynamodb.Table(os.environ["LIVE_AGENTS_TABLE"])
audit = dynamodb.Table(os.environ["AUDIT_EVENTS_TABLE"])
cognito = boto3.client("cognito-idp")
ses = boto3.client("sesv2")
secrets_client = boto3.client("secretsmanager")
_otp_secret = None


def lambda_handler(event, _context):
    try:
        method = event.get("requestContext", {}).get("http", {}).get("method", "GET")
        parts = [p for p in (event.get("rawPath") or "/").split("/") if p][3:]
        body = parse_json_body(event) if method == "POST" else {}
        if parts == ["start"] and method == "POST":
            return response(202, start(body))
        if parts == ["verify"] and method == "POST":
            return response(201, verify(body))
        raise RequestError("Route not found", 404)
    except RequestError as exc:
        return response(exc.status_code, {"message": exc.message})
    except ClientError as exc:
        log.exception("Onboarding AWS operation failed")
        code = exc.response.get("Error", {}).get("Code", "")
        if code in ("UsernameExistsException", "ConditionalCheckFailedException", "TransactionCanceledException"):
            return response(409, {"message": "This company or email is already registered. Sign in or contact support."})
        return response(500, {"message": "Company setup could not be completed. Please try again."})
    except Exception:
        log.exception("Onboarding failed")
        return response(500, {"message": "Company setup is temporarily unavailable."})


def start(body):
    company = required(body, "companyName", 160)
    admin_name = required(body, "adminName", 120)
    admin_email = normalized_email(body.get("adminEmail"))
    live_name = required(body, "liveAgentName", 120)
    live_email = normalized_email(body.get("liveAgentEmail"))
    if admin_email == live_email:
        raise RequestError("Admin and live-agent emails must be different")
    if body.get("acceptedTerms") is not True:
        raise RequestError("Terms and privacy acceptance is required")

    now = int(time.time())
    registration_id = f"reg_{uuid.uuid4().hex}"
    otp = f"{secrets.randbelow(1_000_000):06d}"
    salt = secrets.token_hex(12)
    item = {
        "registrationId": registration_id,
        "status": "PENDING_VERIFICATION",
        "companyName": company,
        "adminName": admin_name,
        "adminEmail": admin_email,
        "liveAgentName": live_name,
        "liveAgentEmail": live_email,
        "slugCandidate": company_slug(company),
        "otpSalt": salt,
        "otpDigest": otp_digest(registration_id, salt, otp),
        "attempts": 0,
        "createdAt": now,
        "expiresAt": now + 600,
    }
    registrations.put_item(Item=item, ConditionExpression="attribute_not_exists(registrationId)")
    ses.send_email(
        FromEmailAddress=os.environ["ONBOARDING_EMAIL_FROM"],
        Destination={"ToAddresses": [admin_email]},
        Content={"Simple": {"Subject": {"Data": "Verify your company workspace"}, "Body": {"Text": {"Data":
            f"Your verification code is {otp}. It expires in 10 minutes. If you did not request this, ignore this email."}}}},
    )
    return {"registrationId": registration_id, "expiresIn": 600, "maskedEmail": mask_email(admin_email)}


def verify(body):
    registration_id = str(body.get("registrationId") or "")[:80]
    otp = str(body.get("verificationCode") or "").strip()
    if not registration_id or not otp.isdigit() or len(otp) != 6:
        raise RequestError("A valid six-digit verification code is required")
    record = registrations.get_item(Key={"registrationId": registration_id}, ConsistentRead=True).get("Item")
    now = int(time.time())
    if not record:
        raise RequestError("Registration not found", 404)
    if record.get("status") == "COMPLETED":
        return completed_result(record)
    if int(record.get("expiresAt", 0)) < now:
        raise RequestError("Verification code expired. Start registration again.", 410)
    if int(record.get("attempts", 0)) >= 5:
        raise RequestError("Too many verification attempts. Start registration again.", 429)
    expected = record.get("otpDigest", "")
    actual = otp_digest(registration_id, record.get("otpSalt", ""), otp)
    if not hmac.compare_digest(expected, actual):
        registrations.update_item(Key={"registrationId": registration_id},
            UpdateExpression="SET attempts = attempts + :one", ExpressionAttributeValues={":one": 1})
        raise RequestError("Verification code is incorrect", 400)

    tenant = tenant_id()
    slug = record["slugCandidate"]
    if record.get("status") == "PROVISIONING":
        tenant, slug = record["tenantId"], record["tenantSlug"]
    else:
        registrations.update_item(Key={"registrationId": registration_id},
            UpdateExpression="SET #status=:status, tenantId=:tenant, tenantSlug=:slug",
            ConditionExpression="#status=:pending", ExpressionAttributeNames={"#status": "status"},
            ExpressionAttributeValues={":status": "PROVISIONING", ":pending": "PENDING_VERIFICATION", ":tenant": tenant, ":slug": slug})

    slugs.put_item(Item={"tenantSlug": slug, "tenantId": tenant, "createdAt": now},
        ConditionExpression="attribute_not_exists(tenantSlug) OR tenantId=:tenant",
        ExpressionAttributeValues={":tenant": tenant})
    tenants.put_item(Item={"tenantId": tenant, "tenantSlug": slug, "companyName": record["companyName"],
        "status": "ACTIVE", "plan": "STARTER", "adminSeatLimit": 1, "liveAgentSeatLimit": 1,
        "usedAdminSeats": 1, "usedLiveAgentSeats": 1, "createdAt": now, "updatedAt": now},
        ConditionExpression="attribute_not_exists(tenantId) OR tenantId=:tenant",
        ExpressionAttributeValues={":tenant": tenant})

    admin = create_cognito_user(tenant, record["adminEmail"], record["adminName"], "COMPANY_ADMIN")
    live = create_cognito_user(tenant, record["liveAgentEmail"], record["liveAgentName"], "LIVE_AGENT")
    put_member(tenant, admin, record["adminEmail"], record["adminName"], "COMPANY_ADMIN", now)
    put_member(tenant, live, record["liveAgentEmail"], record["liveAgentName"], "LIVE_AGENT", now)
    live_agents.put_item(Item={"tenantId": tenant, "userId": live, "email": record["liveAgentEmail"],
        "name": record["liveAgentName"], "presence": "OFFLINE", "status": "ACTIVE", "createdAt": now})
    audit.put_item(Item={"tenantId": tenant, "eventId": f"ONBOARDING#{registration_id}", "action": "TENANT_CREATED",
        "actorId": admin, "resourceId": tenant, "createdAt": now})
    registrations.update_item(Key={"registrationId": registration_id},
        UpdateExpression="SET #status=:done, adminUserId=:admin, liveAgentUserId=:live, completedAt=:now REMOVE otpDigest, otpSalt",
        ExpressionAttributeNames={"#status": "status"},
        ExpressionAttributeValues={":done": "COMPLETED", ":admin": admin, ":live": live, ":now": now})
    record.update({"status": "COMPLETED", "tenantId": tenant, "tenantSlug": slug})
    return completed_result(record)


def create_cognito_user(tenant, email, name, role):
    try:
        result = cognito.admin_create_user(UserPoolId=os.environ["USER_POOL_ID"], Username=email,
            UserAttributes=[{"Name": "email", "Value": email}, {"Name": "email_verified", "Value": "true"},
                {"Name": "name", "Value": name}, {"Name": "custom:tenant_id", "Value": tenant},
                {"Name": "custom:role", "Value": role}], DesiredDeliveryMediums=["EMAIL"])
    except cognito.exceptions.UsernameExistsException:
        result = {"User": cognito.admin_get_user(UserPoolId=os.environ["USER_POOL_ID"], Username=email)}
        attrs = {a["Name"]: a["Value"] for a in result["User"].get("UserAttributes", [])}
        if attrs.get("custom:tenant_id") != tenant or attrs.get("custom:role") != role:
            raise
        result["User"]["Attributes"] = result["User"].get("UserAttributes", [])
    return next((a["Value"] for a in result["User"].get("Attributes", []) if a["Name"] == "sub"), email)


def put_member(tenant, user_id, email, name, role, now):
    members.put_item(Item={"tenantId": tenant, "userId": user_id, "email": email, "name": name,
        "role": role, "status": "INVITED", "createdAt": now})


def otp_digest(registration_id, salt, otp):
    message = f"{registration_id}:{salt}:{otp}".encode()
    return hmac.new(otp_secret().encode(), message, hashlib.sha256).hexdigest()


def otp_secret():
    global _otp_secret
    if not _otp_secret:
        value = secrets_client.get_secret_value(SecretId=os.environ["ONBOARDING_OTP_SECRET_ARN"])
        _otp_secret = value.get("SecretString") or value["SecretBinary"].decode()
    return _otp_secret


def completed_result(record):
    return {"status": "COMPLETED", "tenantId": record.get("tenantId"), "tenantSlug": record.get("tenantSlug"),
        "adminConsoleUrl": "/admin.html", "liveAgentConsoleUrl": "/agent-console.html",
        "message": "Workspace created. Temporary-password invitations were sent to both accounts."}


def required(body, key, limit):
    value = str(body.get(key) or "").strip()
    if len(value) < 2:
        raise RequestError(f"{key} is required")
    return value[:limit]


def mask_email(email):
    local, domain = email.split("@", 1)
    return f"{local[:2]}***@{domain}"


def response(code, body):
    return {"statusCode": code, "headers": {"Content-Type": "application/json", "Cache-Control": "no-store",
        "Access-Control-Allow-Origin": os.environ.get("ALLOWED_ORIGIN", "*")}, "body": json.dumps(body, default=str)}
