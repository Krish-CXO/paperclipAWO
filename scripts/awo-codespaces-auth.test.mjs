import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { test } from "node:test";
import { runtimeEnvironment, settings } from "./awo-dev.mjs";

// Use the server's locked Better Auth dependency, with no PostgreSQL or real users.
const require = createRequire(new URL("../server/package.json", import.meta.url));
const { betterAuth } = await import(require.resolve("better-auth"));
const { memoryAdapter } = await import(require.resolve("better-auth/adapters/memory"));
const config = settings({
  CODESPACES: "true", CODESPACE_NAME: "pleasant-space-abc123",
  GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN: "app.github.dev",
});
const proxyOrigin = `http://localhost:${config.port}`;
const env = runtimeEnvironment(config, {}, {});

function fixture(origins) {
  const store = { user: [], session: [], account: [], verification: [] };
  const auth = betterAuth({
    secret: "codespaces-origin-regression-test-secret-only",
    baseURL: config.publicUrl,
    trustedOrigins: origins,
    database: memoryAdapter(store),
    emailAndPassword: { enabled: true },
    advanced: { useSecureCookies: true },
    logger: { disabled: true },
  });
  return { auth, store };
}

function request(endpoint, origin, body, cookie) {
  return new Request(`${config.publicUrl}/api/auth/${endpoint}`, {
    method: "POST",
    headers: {
      "content-type": "application/json", origin,
      referer: `${config.publicUrl}/auth`, "sec-fetch-site": "same-origin",
      ...(cookie ? { cookie } : {}),
    },
    body: JSON.stringify(body),
  });
}

test("Codespaces signup accepts the proxy's exact rewritten origin while rejecting unrelated origins", async () => {
  assert.deepEqual(env.BETTER_AUTH_TRUSTED_ORIGINS.split(","), [config.publicUrl, proxyOrigin]);
  assert.equal(runtimeEnvironment(settings({}), {}, {}).BETTER_AUTH_TRUSTED_ORIGINS, undefined);
  const credentials = { name: "Test Operator", email: "operator@example.test", password: "synthetic-test-password-only" };
  const before = fixture([config.publicUrl]);
  const blocked = await before.auth.handler(request("sign-up/email", proxyOrigin, credentials));
  assert.equal(blocked.status, 403);
  assert.equal((await blocked.json()).code, "INVALID_ORIGIN");
  assert.equal(before.store.user.length, 0);

  const after = fixture(env.BETTER_AUTH_TRUSTED_ORIGINS.split(","));
  const accepted = await after.auth.handler(request("sign-up/email", proxyOrigin, credentials));
  assert.equal(accepted.status, 200);
  assert.ok(accepted.headers.getSetCookie().some((cookie) => /session_token=.*;\s*Secure(?:;|$)/i.test(cookie)));
  for (const origin of ["https://unrelated.example", "http://localhost:3101"]) {
    const rejected = await after.auth.handler(request("sign-up/email", origin, { ...credentials, email: "other@example.test" }));
    assert.equal(rejected.status, 403);
    assert.equal((await rejected.json()).code, "INVALID_ORIGIN");
  }
  assert.equal(after.store.user.length, 1);
});

test("a fake-cookie sign-out probe checks the same origin gate without creating users or sessions", async () => {
  for (const [origins, origin, expected] of [
    [[config.publicUrl], proxyOrigin, 403],
    [env.BETTER_AUTH_TRUSTED_ORIGINS.split(","), proxyOrigin, 200],
    [env.BETTER_AUTH_TRUSTED_ORIGINS.split(","), "https://unrelated.example", 403],
  ]) {
    const { auth, store } = fixture(origins);
    const response = await auth.handler(request("sign-out", origin, {}, "paperclip-origin-probe=1"));
    assert.equal(response.status, expected);
    if (expected === 403) assert.equal((await response.json()).code, "INVALID_ORIGIN");
    else assert.deepEqual(await response.json(), { success: true });
    assert.deepEqual(store, { user: [], session: [], account: [], verification: [] });
  }
});
