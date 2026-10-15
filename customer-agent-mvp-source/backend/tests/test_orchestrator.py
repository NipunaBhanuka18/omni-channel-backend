import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "src"))

from orchestrator import MainAgentRouter, build_lead_form
from auth import require_principal
from security import RequestError, safe_form_values, validate_agent_key, validate_message
from tenant_security import company_slug, normalized_email, tenant_id, validate_role


class RouterTests(unittest.TestCase):
    def setUp(self):
        self.router = MainAgentRouter()

    def test_explicit_human_request_has_priority(self):
        decision = self.router.route("My internet is slow; let me speak to a human")
        self.assertEqual(decision.route, "handoff")
        self.assertTrue(decision.handoff)

    def test_technical_route(self):
        self.assertEqual(self.router.route("My wifi internet is slow").route, "technical")

    def test_billing_route(self):
        self.assertEqual(self.router.route("Why was I charged on my bill?").route, "billing")

    def test_disabled_route_falls_back(self):
        self.assertEqual(self.router.route("I need a package", ["general"]).route, "general")

    def test_lead_form_is_config_driven(self):
        agent = {"forms": [{"formId": "sales_interest", "title": "Contact", "fields": []}]}
        action = build_lead_form(agent, "sales", "I want a new connection")
        self.assertEqual(action["type"], "form")


class SecurityTests(unittest.TestCase):
    def test_agent_key(self):
        self.assertEqual(validate_agent_key("Demo-Support"), "demo-support")
        with self.assertRaises(RequestError):
            validate_agent_key("../tenant-a")

    def test_message_limit(self):
        with self.assertRaises(RequestError):
            validate_message("x" * 4001)

    def test_form_allows_only_declared_fields(self):
        fields = [{"name": "email", "label": "Email", "required": True, "maxLength": 80}]
        values = safe_form_values({"email": " user@example.com ", "tenantId": "evil"}, fields)
        self.assertEqual(values, {"email": "user@example.com"})

    def test_tenant_identity_comes_from_verified_claims(self):
        event = {"requestContext": {"authorizer": {"jwt": {"claims": {
            "sub": "user-1", "custom:tenant_id": "tenant-a", "custom:role": "COMPANY_ADMIN", "email": "a@example.com"
        }}}}}
        principal = require_principal(event, ("COMPANY_ADMIN",))
        self.assertEqual(principal.tenant_id, "tenant-a")

    def test_wrong_console_role_is_rejected(self):
        event = {"requestContext": {"authorizer": {"jwt": {"claims": {
            "sub": "user-1", "custom:tenant_id": "tenant-a", "custom:role": "LIVE_AGENT"
        }}}}}
        with self.assertRaises(RequestError):
            require_principal(event, ("COMPANY_ADMIN",))

    def test_tenant_identifiers_are_server_generated(self):
        self.assertRegex(tenant_id(), r"^ten_[a-z0-9]{16}$")
        self.assertRegex(company_slug("Acme Holdings (Pvt) Ltd"), r"^acme-holdings-pvt-ltd-[a-f0-9]{6}$")

    def test_member_identity_validation(self):
        self.assertEqual(normalized_email(" Admin@Example.COM "), "admin@example.com")
        self.assertEqual(validate_role("live_agent"), "LIVE_AGENT")
        with self.assertRaises(RequestError):
            normalized_email("not-an-email")
        with self.assertRaises(RequestError):
            validate_role("PLATFORM_ADMIN")


if __name__ == "__main__":
    unittest.main()
