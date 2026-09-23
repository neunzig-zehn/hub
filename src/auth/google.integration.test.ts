import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "vitest";
import { embeddedDatabaseRuntime } from "../db/runtime/index.js";
import { createDatabase } from "../db/pg.js";
import { EntitlementsService } from "../entitlements/service.js";
import { z } from "zod";
import { createAuthServer } from "./server.js";

it("allows only Google sign-in and requests the 90/10 hosted domain", async () => {
  const directory = await mkdtemp(join(tmpdir(), "paseo-google-auth-"));
  const { runtime, locks } = await embeddedDatabaseRuntime(join(directory, "database"));
  try {
    await runtime.migrate();
    const auth = createAuthServer({
      database: runtime,
      locks,
      entitlements: new EntitlementsService(createDatabase(runtime, locks), {
        seats: () => Promise.resolve(0),
      }),
      secret: "a".repeat(32),
      baseURL: "https://paseo.9010.berlin",
      google: {
        clientId: "test-client-id",
        clientSecret: "test-client-secret",
        organizationSlug: "paseo-hub-7005c488",
      },
    });
    assert.equal(
      (
        await auth.handle(
          new Request("https://paseo.9010.berlin/api/auth/sign-in/email", { method: "POST" }),
        )
      ).status,
      404,
    );
    const response = await auth.handle(
      new Request("https://paseo.9010.berlin/api/auth/sign-in/social", {
        method: "POST",
        headers: { "content-type": "application/json", origin: "https://paseo.9010.berlin" },
        body: JSON.stringify({ provider: "google", callbackURL: "https://paseo.9010.berlin/" }),
      }),
    );
    assert.equal(response.status, 200);
    const result = z.object({ url: z.string() }).parse(await response.json());
    const url = new URL(result.url);
    assert.equal(url.hostname, "accounts.google.com");
    assert.equal(url.searchParams.get("hd"), "9010.berlin");
    assert.equal(
      url.searchParams.get("redirect_uri"),
      "https://paseo.9010.berlin/api/auth/callback/google",
    );
  } finally {
    await runtime.close();
    await rm(directory, { recursive: true, force: true });
  }
});
