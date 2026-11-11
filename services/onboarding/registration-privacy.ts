/**
 * Strip credential fields from registration API responses.
 * This is a presentation-only safeguard: legacy plaintext data may still exist
 * in the local demo DB and must be migrated separately.
 */
export function redactRegistrationCredentials(
  registration: Record<string, unknown>,
): Record<string, unknown> {
  const safe = { ...registration };
  delete safe.password;
  delete safe.passwordHash;
  delete safe.temporaryPassword;
  return safe;
}
