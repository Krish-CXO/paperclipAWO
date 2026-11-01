#!/usr/bin/env node
// A local Docker lifecycle wrapper. Runtime behavior remains owned by Paperclip.
import { randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  closeSync, constants, existsSync, fchmodSync, fstatSync, openSync,
  readFileSync, writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const envPath = join(root, "docker/.env.awo");
const composePath = join(root, "docker/compose.awo.yaml");
const volumeName = "paperclip-awo-data";
const commands = new Set(["setup", "start", "stop", "status", "logs", "help"]);

function command(binary, args, options = {}) {
  return spawnSync(binary, args, {
    cwd: root, encoding: "utf8", stdio: "pipe", ...options,
  });
}

function assertIgnored() {
  const ignored = command("git", ["check-ignore", "--quiet", "docker/.env.awo"]);
  if (ignored.error || ignored.status !== 0) {
    throw new Error("docker/.env.awo must be excluded by .gitignore before generating secrets.");
  }
  // A precise exclusion avoids relying on a broader pattern a later rule could undo.
  const dockerIgnore = readFileSync(join(root, ".dockerignore"), "utf8")
    .split(/\r?\n/).map((line) => line.trim());
  if (!dockerIgnore.includes("docker/.env.awo")) {
    throw new Error("Add docker/.env.awo to .dockerignore before generating secrets.");
  }
}

function dockerAvailable() {
  const result = command("docker", ["info", "--format", "{{.ServerVersion}}"], { timeout: 15_000 });
  return !result.error && result.status === 0;
}

function requireDocker() {
  const compose = command("docker", ["compose", "version"], { timeout: 15_000 });
  if (compose.error || compose.status !== 0) {
    throw new Error("Docker Compose v2 is required. Install/start Docker Desktop or Docker Engine with the Compose plugin, then rerun this command.");
  }
  if (!dockerAvailable()) {
    throw new Error("Docker is not reachable. Start Docker Desktop or your Docker Engine and retry.");
  }
}

function createConfig() {
  assertIgnored();
  if (existsSync(envPath)) return;
  // Never replace missing deployment secrets merely because the checkout is new.
  if (!dockerAvailable()) {
    throw new Error("Docker must be running before creating new signing secrets, so setup can check for existing instance data. Start Docker and retry; an existing env file can still be checked offline.");
  }
  const existingVolume = command("docker", ["volume", "inspect", volumeName], { timeout: 15_000 });
  if (!existingVolume.error && existingVolume.status === 0) {
    throw new Error("The Paperclip data volume already exists, but docker/.env.awo is missing. Restore that deployment's env file from backup; new signing secrets will not be generated.");
  }
  // A volume-not-found response is expected; other daemon errors must not be
  // interpreted as evidence that this is a fresh installation.
  if (existingVolume.error || !/no such volume|not found/i.test(existingVolume.stderr || "")) {
    throw new Error("Could not confirm whether the Paperclip data volume exists. Resolve the Docker error before creating a new configuration.");
  }
  const template = readFileSync(join(root, "docker/.env.awo.example"), "utf8");
  const content = template
    .replace("__GENERATED_SESSION_SECRET__", randomBytes(32).toString("hex"))
    .replace("__GENERATED_TOOL_SECRET__", randomBytes(32).toString("hex"));
  // Exclusive creation refuses symlinks and concurrent overwrites.
  writeFileSync(envPath, content, { flag: "wx", mode: 0o600 });
  console.log("Created docker/.env.awo with two independent signing secrets. Keep a private backup with your instance data.");
}

function readConfig() {
  if (!existsSync(envPath)) {
    throw new Error("docker/.env.awo is missing. For a new instance run setup; for an existing instance restore its saved env file.");
  }
  const fd = openSync(envPath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  let config;
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) throw new Error("docker/.env.awo must be a regular file.");
    if (process.getuid && stat.uid !== process.getuid()) {
      throw new Error("docker/.env.awo must be owned by the user running this launcher.");
    }
    if (process.platform !== "win32") fchmodSync(fd, 0o600);
    config = parseEnv(readFileSync(fd, "utf8"));
  } finally {
    closeSync(fd);
  }
  const secretNames = ["BETTER_AUTH_SECRET", "PAPERCLIP_TOOL_ACTION_SIGNING_SECRET"];
  for (const name of secretNames) {
    if (!config[name] || config[name].length < 32 || config[name].startsWith("__GENERATED_")) {
      throw new Error(`${name} in docker/.env.awo is missing or invalid. Restore the saved value for an existing deployment; setup never rotates secrets.`);
    }
  }
  if (config[secretNames[0]] === config[secretNames[1]]) {
    throw new Error("The session and tool-action signing secrets must be different.");
  }
  const port = config.PAPERCLIP_PORT || "3100";
  if (!/^\d+$/.test(port) || Number(port) < 1024 || Number(port) > 65535) {
    throw new Error("PAPERCLIP_PORT in docker/.env.awo must be an integer from 1024 to 65535.");
  }
  config.PAPERCLIP_PORT = port;
  const urlValue = config.PAPERCLIP_PUBLIC_URL || `http://localhost:${port}`;
  let url;
  try { url = new URL(urlValue); } catch {
    throw new Error("PAPERCLIP_PUBLIC_URL must be a valid HTTP(S) origin.");
  }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== "/") {
    throw new Error("PAPERCLIP_PUBLIC_URL must be an HTTP(S) origin without credentials, a path, query or fragment.");
  }
  config.PAPERCLIP_PUBLIC_URL = url.origin;
  return config;
}

function composeEnvironment(config) {
  const revision = command("git", ["rev-parse", "HEAD"]);
  const commit = revision.stdout?.trim();
  if (revision.error || revision.status !== 0 || !/^[0-9a-f]{40}$/.test(commit || "")) {
    throw new Error("Run from a Git checkout with a valid commit so the Docker image can record its source revision.");
  }
  // Saved configuration wins over stale shell variables, especially secrets.
  // Keep provider credentials opt-in: inherited API keys are not injected.
  return {
    ...process.env,
    OPENAI_API_KEY: "", ANTHROPIC_API_KEY: "", PAPERCLIP_ALLOWED_HOSTNAMES: "",
    ...config,
    PAPERCLIP_BUILD_COMMIT: commit,
  };
}

function compose(args, env) {
  const result = command("docker", [
    "compose", "--project-name", "paperclip-awo", "--env-file", envPath,
    "--file", composePath, ...args,
  ], { env, stdio: "inherit" });
  if (result.error) throw new Error(`Could not run Docker Compose: ${result.error.message}`);
  if (result.status !== 0) {
    throw new Error(`Docker Compose failed (exit ${result.status ?? result.signal}). Check the output above; existing data and secrets were retained.`);
  }
}

function help() {
  console.log(`Paperclip AWO — local Docker setup

  node scripts/awo-docker.mjs setup   Create private configuration once (Docker running)
  node scripts/awo-docker.mjs start   Build and start; wait for a healthy server
  node scripts/awo-docker.mjs status  Show container state
  node scripts/awo-docker.mjs logs    Follow the last 200 application log lines
  node scripts/awo-docker.mjs stop    Stop containers and keep all instance data

Requires Node.js, Git, Docker Engine/Desktop and Docker Compose v2 with up --wait.
The app is bound to 127.0.0.1 only. Edit docker/.env.awo to change its port.
State persists in Docker volume ${volumeName}; private config stays in docker/.env.awo.
After start, create your Paperclip account and claim the instance in the browser.
Then open Apps → Connections and connect a provider before creating agent tasks.
Back up the whole data volume plus docker/.env.awo; DB dumps alone omit uploaded files and encryption keys.`);
}

function main() {
  const action = process.argv[2] || "help";
  if (!commands.has(action) || process.argv.length > 3) {
    throw new Error("Use one of: setup, start, stop, status, logs, help.");
  }
  if (action === "help") return help();
  if (action === "setup") {
    createConfig();
    readConfig();
    console.log("Configuration ready. Existing signing secrets were preserved. Run node scripts/awo-docker.mjs start when Docker is available.");
    return;
  }
  requireDocker();
  if (action === "start") createConfig();
  const config = readConfig();
  const env = composeEnvironment(config);
  compose(["config", "--quiet"], env);
  if (action === "start") {
    compose(["up", "--detach", "--build", "--wait", "--wait-timeout", "600"], env);
    console.log(`Paperclip is healthy: ${config.PAPERCLIP_PUBLIC_URL}`);
    console.log("For a new instance, create your account and select Claim this instance. Then connect your AI account under Apps → Connections.");
  } else if (action === "stop") {
    compose(["stop"], env);
    console.log("Paperclip stopped. Its data volume and saved configuration are retained.");
  } else if (action === "status") {
    compose(["ps", "--all"], env);
  } else {
    compose(["logs", "--tail", "200", "--follow", "paperclip"], env);
  }
}

try { main(); } catch (error) {
  console.error(`Paperclip setup: ${error instanceof Error ? error.message : "Unexpected error"}`);
  process.exitCode = 1;
}
