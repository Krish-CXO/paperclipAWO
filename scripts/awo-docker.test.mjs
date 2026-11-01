import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync,
  rmSync, statSync, symlinkSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";
import test from "node:test";

const sourceRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const hash = (value) => createHash("sha256").update(value).digest("hex");

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "paperclip-awo-docker-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const dir of ["scripts", "docker", "bin"]) mkdirSync(join(root, dir));
  for (const file of ["scripts/awo-docker.mjs", "docker/.env.awo.example", "docker/compose.awo.yaml"]) {
    copyFileSync(join(sourceRoot, file), join(root, file));
  }
  writeFileSync(join(root, ".gitignore"), "docker/.env.awo\n");
  writeFileSync(join(root, ".dockerignore"), "docker/.env.awo\n");
  for (const args of [
    ["init", "--quiet"],
    ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "--quiet", "--allow-empty", "-m", "test fixture"],
  ]) {
    const git = spawnSync("git", args, { cwd: root, encoding: "utf8" });
    assert.equal(git.status, 0, git.stderr);
  }
  const log = join(root, "docker-calls.jsonl");
  const docker = join(root, "bin/docker");
  writeFileSync(docker, `#!/usr/bin/env node
import { appendFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
const args = process.argv.slice(2);
const hash = (value) => value ? createHash('sha256').update(value).digest('hex') : null;
appendFileSync(process.env.AWO_TEST_LOG, JSON.stringify({ args, session: hash(process.env.BETTER_AUTH_SECRET), tool: hash(process.env.PAPERCLIP_TOOL_ACTION_SIGNING_SECRET), apiKey: hash(process.env.OPENAI_API_KEY), url: process.env.PAPERCLIP_PUBLIC_URL, commit: process.env.PAPERCLIP_BUILD_COMMIT }) + '\\n');
if (args[0] === 'info' && process.env.AWO_TEST_DOCKER_OFFLINE === '1') process.exit(1);
if (args[0] === 'volume' && args[1] === 'inspect') {
  if (process.env.AWO_TEST_VOLUME_EXISTS === '1') process.exit(0);
  console.error('Error response from daemon: no such volume');
  process.exit(1);
}
if (args.includes('up') && process.env.AWO_TEST_START_FAIL === '1') process.exit(7);
process.exit(0);
`);
  // A package type marker makes the extensionless fake command an ES module.
  writeFileSync(join(root, "package.json"), '{"type":"module"}\n');
  chmodSync(docker, 0o755);
  const env = {
    ...process.env,
    PATH: `${join(root, "bin")}${delimiter}${process.env.PATH}`,
    AWO_TEST_LOG: log,
  };
  const run = (action, extraEnv = {}) => spawnSync(process.execPath, [join(root, "scripts/awo-docker.mjs"), action], {
    cwd: tmpdir(), encoding: "utf8", env: { ...env, ...extraEnv },
  });
  const calls = () => existsSync(log)
    ? readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line))
    : [];
  return { root, run, calls, envPath: join(root, "docker/.env.awo") };
}

test("setup creates private independent secrets once and never prints or rotates them", (t) => {
  const f = fixture(t);
  const first = f.run("setup");
  assert.equal(first.status, 0, first.stderr);
  const before = readFileSync(f.envPath, "utf8");
  const saved = parseEnv(before);
  assert.match(saved.BETTER_AUTH_SECRET, /^[a-f0-9]{64}$/);
  assert.match(saved.PAPERCLIP_TOOL_ACTION_SIGNING_SECRET, /^[a-f0-9]{64}$/);
  assert.notEqual(saved.BETTER_AUTH_SECRET, saved.PAPERCLIP_TOOL_ACTION_SIGNING_SECRET);
  if (process.platform !== "win32") assert.equal(statSync(f.envPath).mode & 0o777, 0o600);
  const again = f.run("setup");
  assert.equal(again.status, 0, again.stderr);
  assert.equal(readFileSync(f.envPath, "utf8"), before);
  for (const secret of [saved.BETTER_AUTH_SECRET, saved.PAPERCLIP_TOOL_ACTION_SIGNING_SECRET]) {
    assert.ok(!(first.stdout + first.stderr + again.stdout + again.stderr).includes(secret));
  }
});

test("setup refuses missing secrets for an existing data volume", (t) => {
  const f = fixture(t);
  const result = f.run("setup", { AWO_TEST_VOLUME_EXISTS: "1" });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Restore that deployment's env file/);
  assert.equal(existsSync(f.envPath), false);
});

test("setup never generates replacement secrets while the Docker data volume cannot be checked", (t) => {
  const f = fixture(t);
  const result = f.run("setup", { AWO_TEST_DOCKER_OFFLINE: "1" });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Docker must be running/);
  assert.equal(existsSync(f.envPath), false);
  assert.equal(f.run("setup").status, 0);
  const before = readFileSync(f.envPath, "utf8");
  assert.equal(f.run("setup", { AWO_TEST_DOCKER_OFFLINE: "1" }).status, 0);
  assert.equal(readFileSync(f.envPath, "utf8"), before);
});

test("setup requires Git and Docker exclusions before writing secrets", (t) => {
  const f = fixture(t);
  writeFileSync(join(f.root, ".gitignore"), "");
  assert.equal(f.run("setup").status, 1);
  assert.equal(existsSync(f.envPath), false);
  writeFileSync(join(f.root, ".gitignore"), "docker/.env.awo\n");
  writeFileSync(join(f.root, ".dockerignore"), "");
  const result = f.run("setup");
  assert.equal(result.status, 1);
  assert.match(result.stderr, /\.dockerignore/);
  assert.equal(existsSync(f.envPath), false);
});

test("start uses saved secrets, derives a changed port URL, waits for health and stop keeps volumes", (t) => {
  const f = fixture(t);
  assert.equal(f.run("setup").status, 0);
  const content = readFileSync(f.envPath, "utf8").replace("PAPERCLIP_PORT=3100", "PAPERCLIP_PORT=3210");
  writeFileSync(f.envPath, content, { mode: 0o600 });
  const saved = parseEnv(content);
  const result = f.run("start", {
    BETTER_AUTH_SECRET: "stale-shell-value-must-not-win",
    PAPERCLIP_TOOL_ACTION_SIGNING_SECRET: "stale-tool-value-must-not-win",
    OPENAI_API_KEY: "unrequested-shell-key-must-not-be-used",
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /http:\/\/localhost:3210/);
  const up = f.calls().find((call) => call.args.includes("up"));
  assert.ok(up);
  assert.deepEqual(up.args.slice(-6), ["up", "--detach", "--build", "--wait", "--wait-timeout", "600"]);
  assert.equal(up.session, hash(saved.BETTER_AUTH_SECRET));
  assert.equal(up.tool, hash(saved.PAPERCLIP_TOOL_ACTION_SIGNING_SECRET));
  assert.equal(up.apiKey, null);
  assert.equal(up.url, "http://localhost:3210");
  assert.match(up.commit, /^[a-f0-9]{40}$/);
  assert.equal(f.run("stop").status, 0);
  const last = f.calls().at(-1);
  assert.equal(last.args.at(-1), "stop");
  assert.ok(!f.calls().some((call) => call.args.includes("--volumes") || call.args.includes("rm")));
  assert.equal(readFileSync(f.envPath, "utf8"), content);
});

test("invalid or symlinked config fails without replacing the file", (t) => {
  const f = fixture(t);
  assert.equal(f.run("setup").status, 0);
  const invalid = readFileSync(f.envPath, "utf8").replace(/^BETTER_AUTH_SECRET=.*$/m, "BETTER_AUTH_SECRET=");
  writeFileSync(f.envPath, invalid);
  const result = f.run("setup");
  assert.equal(result.status, 1);
  assert.match(result.stderr, /missing or invalid/);
  assert.equal(readFileSync(f.envPath, "utf8"), invalid);
  if (process.platform !== "win32") {
    const target = join(f.root, "private.env");
    writeFileSync(target, invalid);
    rmSync(f.envPath);
    symlinkSync(target, f.envPath);
    assert.equal(f.run("setup").status, 1);
    assert.equal(readFileSync(target, "utf8"), invalid);
  }
});

test("failed Docker startup is never reported as healthy", (t) => {
  const f = fixture(t);
  const result = f.run("start", { AWO_TEST_START_FAIL: "1" });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Docker Compose failed/);
  assert.ok(!result.stdout.includes("Paperclip is healthy"));
  assert.equal(existsSync(f.envPath), true);
});
