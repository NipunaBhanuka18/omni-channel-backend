/** Offline response-privacy tests. No server, db.json, or AWS services used. */
import assert from "node:assert/strict";
import { redactRegistrationCredentials } from "../services/onboarding/registration-privacy";

const input = {
  id: "reg-test-only",
  companyName: "Offline Test Company",
  adminEmail: "offline@example.test",
  status: "Pending",
  password: "FAKE-DO-NOT-USE",
  passwordHash: "FAKE-HASH",
  temporaryPassword: "FAKE-TEMPORARY",
};
const redacted = redactRegistrationCredentials(input);
assert.deepEqual(redacted, {
  id: "reg-test-only",
  companyName: "Offline Test Company",
  adminEmail: "offline@example.test",
  status: "Pending",
});
console.log("PASS: Registration response omits all three credential fields");

assert.equal(input.password, "FAKE-DO-NOT-USE");
assert.equal(input.passwordHash, "FAKE-HASH");
assert.equal(input.temporaryPassword, "FAKE-TEMPORARY");
console.log("PASS: Redaction does not mutate the input record");

const list = [input, { ...input, id: "reg-test-only-2", password: "DIFFERENT-FAKE" }]
  .map(redactRegistrationCredentials);
assert.equal(list.length, 2);
assert.ok(list.every((item) =>
  !("password" in item) && !("passwordHash" in item) && !("temporaryPassword" in item)
));
console.log("PASS: Registration list responses omit credentials for all records");

assert.ok(!JSON.stringify(list).includes("FAKE-DO-NOT-USE"));
assert.ok(!JSON.stringify(list).includes("DIFFERENT-FAKE"));
console.log("PASS: Serialized responses contain no test passwords");
console.log("\n--- 4 passed, 0 failed ---");
