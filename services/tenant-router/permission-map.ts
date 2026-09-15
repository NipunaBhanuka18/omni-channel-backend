import { PERMISSIONS } from "../../shared/constants/permissions";

/**
 * ==============================================================================
 * Intent-to-Permission Mapping (RBAC Matrix)
 * ==============================================================================
 * Maps business intents to required fine-grained permissions.
 * Structure this map so adding a new intent -> permission mapping is a single-line addition.
 */
export const INTENT_PERMISSION_MAP: Record<string, string> = {
  check_balance: PERMISSIONS.BILLING_READ,
  pay_bill: PERMISSIONS.BILLING_PURCHASE,
  check_usage: PERMISSIONS.USAGE_READ,
  troubleshoot_router: PERMISSIONS.FAULTS_READ,
};

/**
 * Resolves the required permission for a given business intent.
 *
 * SECURITY DESIGN: FAIL CLOSED
 * If an intent is not explicitly mapped in INTENT_PERMISSION_MAP, this function returns undefined.
 * Callers MUST treat undefined as access denied (fail closed) to ensure any future/unmapped intents
 * are not silently permissive or permitted without explicit security authorization.
 *
 * @param intent The business intent string (e.g. "check_balance")
 * @returns The required permission string or undefined if unmapped
 */
export function getRequiredPermissionForIntent(intent: string): string | undefined {
  return INTENT_PERMISSION_MAP[intent];
}
