import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ensurePrivatePort, ensureSecrets, runtimeEnvironment, settings } from "./awo-dev.mjs";

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

function fakeGh(t, mode) {
  const dir = mkdtempSync(path.join(tmpdir(), "awo-dev-gh-"));
  const previous = { PATH: process.env.PATH, CODESPACE_NAME: process.env.CODESPACE_NAME };
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(dir, { recursive: true, force: true });
  });
  writeFileSync(path.join(dir, "gh"), `#!${process.execPath}
import { appendFileSync, existsSync, writeFileSync } from "node:fs";
const dir = ${JSON.stringify(dir)};
const mode = ${JSON.stringify(mode)};
const args = process.argv.slice(2);
appendFileSync(dir + "/calls", JSON.stringify(args) + "\\n");
if (args[2] === "forward") {
  writeFileSync(dir + "/forward-pid", String(process.pid));
  process.on("SIGTERM", () => { writeFileSync(dir + "/closed", "yes"); process.exit(0); });
  setInterval(() => {}, 1000);
} else if (args[2] === "visibility") {
  if (mode === "forbidden") { console.error("HTTP 403: sensitive-detail-must-not-leak"); process.exit(1); }
  if (!existsSync(dir + "/forward-pid")) { console.error("HTTP 404: tunnel port not found"); process.exit(1); }
} else {
  console.log(JSON.stringify([{ sourcePort: 3100, visibility: mode === "public" ? "public" : "private" }]));
}
`, { mode: 0o700 });
  process.env.PATH = `${dir}${path.delimiter}${previous.PATH}`;
  process.env.CODESPACE_NAME = "test-space-abc";
  return dir;
}

test("fresh Codespaces create a private tunnel before launch and clean up only their forwarding client", async (t) => {
  const dir = fakeGh(t, "private");
  await ensurePrivatePort({ codespaces: true, port: 3100 });
  const calls = readFileSync(path.join(dir, "calls"), "utf8").trim().split("\n").map(JSON.parse);
  assert.ok(calls.some((args) => args[2] === "forward" && args[3] === "3100:0"));
  assert.ok(calls.some((args) => args.includes("sourcePort,visibility")));
  assert.equal(readFileSync(path.join(dir, "closed"), "utf8"), "yes");
});

test("Codespaces launch remains blocked when private visibility cannot be verified", async (t) => {
  const dir = fakeGh(t, "public");
  await assert.rejects(ensurePrivatePort({ codespaces: true, port: 3100 }), /Could not verify private forwarding/);
  assert.equal(readFileSync(path.join(dir, "closed"), "utf8"), "yes");
});

test("Codespaces authorization failures cannot trigger port creation or expose CLI response details", async (t) => {
  const dir = fakeGh(t, "forbidden");
  await assert.rejects(ensurePrivatePort({ codespaces: true, port: 3100 }), (error) => {
    assert.match(error.message, /launch was blocked/);
    assert.doesNotMatch(error.message, /sensitive-detail/);
    return true;
  });
  const calls = readFileSync(path.join(dir, "calls"), "utf8").trim().split("\n").map(JSON.parse);
  assert.equal(calls.length, 1);
});
