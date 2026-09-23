import assert from "node:assert/strict";
import { test } from "vitest";
import { decryptCredential, encryptCredential, providerCredentialKey } from "./crypto.js";

test("provider credentials are encrypted and bound to their workspace and account", () => {
  const key = providerCredentialKey("a production-length test secret for this check");
  const identity = { organizationId: "workspace-1", id: "account-1", family: "codex" };
  const plaintext = JSON.stringify({ tokens: { refresh_token: "secret" } });
  const stored = encryptCredential(key, identity, plaintext);
  assert.doesNotMatch(stored, /refresh_token|secret/u);
  assert.equal(decryptCredential(key, identity, stored), plaintext);
  assert.throws(() =>
    decryptCredential(key, { ...identity, organizationId: "workspace-2" }, stored),
  );
});
