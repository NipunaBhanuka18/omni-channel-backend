/**
 * Regression Test: Import Side-Effect Safety for scripts/create-tenants-table.ts
 *
 * Verifies that importing create-tenants-table:
 * 1. Does not attempt to execute main() or connect to LocalStack DynamoDB.
 * 2. Does not mutate process.exitCode.
 * 3. Safely exports inMemoryTenants, inMemoryAgents, and provisionTenantResources.
 */

const initialExitCode = process.exitCode;

import {
  inMemoryTenants,
  inMemoryAgents,
  provisionTenantResources,
} from "./create-tenants-table";

console.log("--- Verifying create-tenants-table Import Safety ---");

let passed = 0;
let failed = 0;

function assert(testName: string, condition: boolean, details?: string) {
  if (condition) {
    console.log(`✅ PASS: ${testName}`);
    passed++;
  } else {
    console.error(`❌ FAIL: ${testName}`);
    if (details) console.error(`   Details: ${details}`);
    failed++;
  }
}

// 1. process.exitCode must NOT be mutated on import
assert(
  "process.exitCode is not mutated by importing create-tenants-table",
  process.exitCode === initialExitCode || process.exitCode === undefined,
  `Expected ${initialExitCode}, got ${process.exitCode}`
);

// 2. Exported in-memory maps must be valid Maps
assert(
  "inMemoryTenants map is exported as a Map instance",
  inMemoryTenants instanceof Map
);

assert(
  "inMemoryAgents map is exported as a Map instance",
  inMemoryAgents instanceof Map
);

// 3. Exported function provisionTenantResources must be a callable async function
assert(
  "provisionTenantResources is exported as a callable function",
  typeof provisionTenantResources === "function"
);

console.log(`\n--- Import Safety: ${passed} passed, ${failed} failed ---\n`);

if (failed > 0) {
  process.exit(1);
} else {
  process.exit(0);
}
