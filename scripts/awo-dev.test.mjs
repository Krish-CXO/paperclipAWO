import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ensureSecrets, runtimeEnvironment, settings } from "./awo-dev.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("signing identities persist across restarts and remain separate and private", (t) => {
  const state = mkdtempSync(path.join(tmpdir(), "awo-dev-secrets-"));
  t.after(() => rmSync(state, { recursive: true, force: true }));
  const first = ensureSecrets(state);
  assert.notEqual(first.BETTER_AUTH_SECRET, first.PAPERCLIP_TOOL_ACTION_SIGNING_SECRET);
  assert.deepEqual(ensureSecrets(state), first);
  assert.equal(statSync(path.join(state, "awo-signing-secrets.json")).mode & 0o777, 0o600);
  assert.equal(statSync(state).mode & 0o777, 0o700);
});

test("missing or corrupt signing identities never silently rotate an existing instance", (t) => {
  const state = mkdtempSync(path.join(tmpdir(), "awo-dev-restore-"));
  t.after(() => rmSync(state, { recursive: true, force: true }));
  mkdirSync(path.join(state, "instances", "default", "db"), { recursive: true });
  assert.throws(() => ensureSecrets(state), /Restore awo-signing-secrets/);
  const secretPath = path.join(state, "awo-signing-secrets.json");
  writeFileSync(secretPath, '{"old":"invalid"}');
  assert.throws(() => ensureSecrets(state), /was not replaced/);
  assert.equal(readFileSync(secretPath, "utf8"), '{"old":"invalid"}');
});

test("runtime data cannot be placed in the repository, including through symlinks", (t) => {
  assert.throws(() => settings({ AWO_DATA_DIR: path.join(root, "data", "private") }), /outside the repository/);
  const temp = mkdtempSync(path.join(tmpdir(), "awo-dev-link-"));
  t.after(() => rmSync(temp, { recursive: true, force: true }));
  const linked = path.join(temp, "repo-link");
  symlinkSync(root, linked, "dir");
  assert.throws(() => ensureSecrets(linked), /resolves inside the repository/);
});

test("Codespaces derives the exact forwarded origin and isolates the app from workspace credentials", () => {
  const config = settings({ CODESPACES: "true", CODESPACE_NAME: "pleasant-space-abc123", GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN: "app.github.dev" });
  assert.equal(config.publicUrl, "https://pleasant-space-abc123-3100.app.github.dev");
  assert.equal(config.stateDir, "/workspaces/.paperclip-awo");
  const env = runtimeEnvironment(config, { BETTER_AUTH_SECRET: "local-signing-key" }, {
    DATABASE_URL: "do-not-use", GITHUB_TOKEN: "workspace-only", GH_TOKEN: "workspace-only",
    PAPERCLIP_CONFIG: "/another/instance.json", PAPERCLIP_MANAGED_CONFIG: "do-not-use",
    PATH: "/tools/bin",
  });
  assert.equal(env.GITHUB_TOKEN, undefined);
  assert.equal(env.GH_TOKEN, undefined);
  assert.equal(env.DATABASE_URL, undefined);
  assert.equal(env.PAPERCLIP_MANAGED_CONFIG, undefined);
  assert.equal(env.PAPERCLIP_ALLOWED_HOSTNAMES, "pleasant-space-abc123-3100.app.github.dev");
  assert.equal(env.PAPERCLIP_CONFIG, "/workspaces/.paperclip-awo/instances/default/config.json");
  assert.equal(env.HOST, "127.0.0.1");
  assert.equal(env.PATH, "/tools/bin");
});

test("invalid or incomplete Codespaces routing fails before launch", () => {
  assert.throws(() => settings({ CODESPACES: "true" }), /Codespaces must provide/);
  assert.throws(() => settings({ AWO_PORT: "3100ignored" }), /AWO_PORT/);
});
