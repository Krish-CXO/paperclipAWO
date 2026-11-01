#!/usr/bin/env node
// Fork-specific launcher. The upstream dev runner owns application processes,
// database migrations, native runner builds, and graceful shutdown.
import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  chmodSync, closeSync, existsSync, lstatSync, mkdirSync, openSync,
  readFileSync, realpathSync, writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import net from "node:net";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const scriptPath = fileURLToPath(import.meta.url);
const repoRoot = path.resolve(path.dirname(scriptPath), "..");
const pnpmBin = process.platform === "win32" ? "pnpm.cmd" : "pnpm";

export function settings(env = process.env, root = repoRoot) {
  const portText = env.AWO_PORT || "3100";
  if (!/^\d+$/.test(portText) || Number(portText) < 1024 || Number(portText) > 65535) {
    throw new Error("AWO_PORT must be a port between 1024 and 65535.");
  }
  const codespaces = env.CODESPACES === "true";
  const stateDir = path.resolve(env.AWO_DATA_DIR || (codespaces
    ? "/workspaces/.paperclip-awo"
    : path.join(homedir(), ".paperclip-awo")));
  const relative = path.relative(root, stateDir);
  if (relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))) {
    throw new Error("AWO_DATA_DIR must be outside the repository so runtime data and secrets cannot be committed.");
  }
  let publicUrl = `http://localhost:${portText}`;
  if (codespaces) {
    const name = env.CODESPACE_NAME;
    const domain = env.GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN;
    if (!name || !/^[a-z0-9-]+$/.test(name) || !domain || !/^[a-z0-9.-]+$/.test(domain)) {
      throw new Error("Codespaces must provide CODESPACE_NAME and GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN.");
    }
    publicUrl = `https://${name}-${portText}.${domain}`;
  }
  return { stateDir, port: Number(portText), codespaces, publicUrl };
}

export function ensureSecrets(stateDir) {
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const actual = realpathSync(stateDir);
  const relative = path.relative(realpathSync(repoRoot), actual);
  if (relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))) {
    throw new Error("The runtime data directory resolves inside the repository.");
  }
  chmodSync(stateDir, 0o700);
  const secretPath = path.join(stateDir, "awo-signing-secrets.json");
  if (existsSync(secretPath) && !lstatSync(secretPath).isFile()) {
    throw new Error("The signing secret path must be a regular file, not a link.");
  }
  if (!existsSync(secretPath)) {
    if (existsSync(path.join(stateDir, "instances"))) {
      throw new Error("Signing secrets are missing from an existing instance. Restore awo-signing-secrets.json from your backup; no new keys were generated.");
    }
    try {
      writeFileSync(secretPath, `${JSON.stringify({
        BETTER_AUTH_SECRET: randomBytes(32).toString("hex"),
        PAPERCLIP_TOOL_ACTION_SIGNING_SECRET: randomBytes(32).toString("hex"),
      })}\n`, { mode: 0o600, flag: "wx" });
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
    }
  }
  const secrets = JSON.parse(readFileSync(secretPath, "utf8"));
  const keys = ["BETTER_AUTH_SECRET", "PAPERCLIP_TOOL_ACTION_SIGNING_SECRET"];
  if (keys.some((key) => !/^[a-f0-9]{64}$/.test(secrets[key] || "")) || secrets[keys[0]] === secrets[keys[1]]) {
    throw new Error("Existing signing secrets are invalid. Restore the original file; it was not replaced.");
  }
  chmodSync(secretPath, 0o600);
  return Object.fromEntries(keys.map((key) => [key, secrets[key]]));
}

export function runtimeEnvironment(config, secrets, env = process.env) {
  const result = { ...env };
  // Never redirect this named instance into another Paperclip instance/database.
  for (const key of ["DATABASE_URL", "DATABASE_MIGRATION_URL", "PAPERCLIP_CONFIG", "PAPERCLIP_CONTEXT", "PAPERCLIP_MANAGED_CONFIG", "PAPERCLIP_MANAGED_RUNTIME_PUBLIC_URL"]) delete result[key];
  // GitHub's Codespaces token is for workspace management, not agent delegation.
  for (const key of ["GITHUB_TOKEN", "GH_TOKEN", "GITHUB_CODESPACES_TOKEN"]) delete result[key];
  return {
    ...result, ...secrets,
    PAPERCLIP_HOME: config.stateDir,
    PAPERCLIP_INSTANCE_ID: "default",
    PAPERCLIP_CONFIG: path.join(config.stateDir, "instances", "default", "config.json"),
    PAPERCLIP_CONTEXT: path.join(config.stateDir, "context.json"),
    PAPERCLIP_PUBLIC_URL: config.publicUrl,
    PAPERCLIP_AUTH_PUBLIC_BASE_URL: config.publicUrl,
    PAPERCLIP_ALLOWED_HOSTNAMES: new URL(config.publicUrl).hostname,
    HOST: "127.0.0.1",
    PORT: String(config.port),
    PAPERCLIP_AUTH_RATE_LIMIT_ENABLED: "true",
    PAPERCLIP_TELEMETRY_DISABLED: "1",
    DO_NOT_TRACK: "1",
    PAPERCLIP_OPEN_BROWSER: "false",
    PAPERCLIP_UI_DEV_MIDDLEWARE: "false",
    SERVE_UI: "true",
  };
}

function command(binary, args, options = {}) {
  const result = spawnSync(binary, args, { cwd: repoRoot, stdio: "inherit", ...options });
  if (result.error) throw new Error(`${binary} is unavailable: ${result.error.message}`);
  if (result.status !== 0) throw new Error(`${binary} failed (exit ${result.status ?? result.signal}).`);
}

function verifyTools() {
  const [major, minor] = process.versions.node.split(".").map(Number);
  if (major < 24 || (major === 24 && minor < 11)) throw new Error("Install Node.js 24.11 or later.");
  const result = spawnSync(pnpmBin, ["--version"], { cwd: repoRoot, encoding: "utf8" });
  if (result.status !== 0 || result.stdout.trim() !== "9.15.4") throw new Error("Install the repository's pnpm version: corepack prepare pnpm@9.15.4 --activate");
  command("cargo", ["--version"], { cwd: path.join(repoRoot, "packages/paperclip-runner") });
  command("python3", ["--version"]);
}

async function health(config) {
  try {
    const response = await fetch(`http://127.0.0.1:${config.port}/api/health`, { signal: AbortSignal.timeout(3000) });
    if (!response.ok) return null;
    return await response.json();
  } catch { return null; }
}

function registeredHere(config) {
  const result = spawnSync(pnpmBin, ["dev:list", "--data-dir", config.stateDir], {
    cwd: repoRoot, encoding: "utf8", env: runtimeEnvironment(config, {}),
  });
  return result.status === 0 && result.stdout.split("\n").some((line) =>
    line.startsWith("paperclip-dev-") && line.includes(`cwd=${repoRoot}`) && line.endsWith(`url=http://127.0.0.1:${config.port}`));
}

async function requireFreePort(port) {
  await new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once("error", () => reject(new Error(`Port ${port} is occupied. Stop the existing server or set AWO_PORT.`)));
    probe.listen(port, "127.0.0.1", () => probe.close(resolve));
  });
}

export async function ensurePrivatePort(config) {
  if (!config.codespaces) return;
  const selector = ["-c", process.env.CODESPACE_NAME];
  const gh = (args) => spawnSync("gh", ["codespace", "ports", ...args, ...selector], {
    cwd: repoRoot, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 30_000,
  });
  const visibilityArgs = ["visibility", `${config.port}:private`];
  const isPrivate = () => {
    const result = gh(["--json", "sourcePort,visibility"]);
    if (result.status !== 0) return false;
    try {
      return JSON.parse(result.stdout).some((port) => port.sourcePort === config.port && port.visibility === "private");
    } catch { return false; }
  };
  const failure = () => new Error(`Could not verify private forwarding for port ${config.port}. Paperclip launch was blocked. Check gh codespace ports -c ${process.env.CODESPACE_NAME}.`);
  let result = gh(visibilityArgs);
  if (result.status === 0) {
    if (!isPrivate()) throw failure();
    return;
  }
  if (result.error || !/\b404\b/.test(result.stderr || "")) throw failure();

  // Visibility can only be set on an existing tunnel port. On a fresh Codespace,
  // create it before starting the app, independently of editor auto-forwarding.
  // gh creates a private remote tunnel and binds an ephemeral local loopback port.
  const forward = spawn("gh", ["codespace", "ports", "forward", `${config.port}:0`, ...selector], {
    cwd: repoRoot, stdio: "ignore",
  });
  let forwardError = null;
  forward.once("error", (error) => { forwardError = error; });
  try {
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
      await delay(1000);
      result = gh(visibilityArgs);
      if (result.status === 0) {
        if (!isPrivate()) throw failure();
        return;
      }
      if (forwardError || forward.exitCode !== null || forward.signalCode !== null || result.error || !/\b404\b/.test(result.stderr || "")) throw failure();
    }
    throw failure();
  } finally {
    // Closing this temporary client leaves the remote forwarded port in place.
    // Only terminate the child created here, never another port-forwarding client.
    if (forward.exitCode === null && forward.signalCode === null) {
      const closed = new Promise((resolve) => forward.once("close", resolve));
      forward.kill("SIGTERM");
      await Promise.race([closed, delay(2000, undefined, { ref: false })]);
      if (forward.exitCode === null && forward.signalCode === null) forward.kill("SIGKILL");
    }
  }
}

function printReady(config, value) {
  console.log(`Paperclip AWO: ${config.publicUrl}`);
  console.log(`Database: ${value.status}; authentication: ${value.deploymentMode}; onboarding: ${value.bootstrapStatus || "check in browser"}.`);
}

async function main() {
  const action = process.argv[2] || "help";
  if (!["setup", "run", "start", "stop", "status", "help"].includes(action)) throw new Error(`Unknown command: ${action}`);
  if (action === "help") {
    console.log("Usage: node scripts/awo-dev.mjs setup|run|start|stop|status\nOptional: AWO_DATA_DIR (outside this repo), AWO_PORT (default 3100).\nsetup installs locked dependencies and builds the UI. run stays in this terminal; start launches in the background.\nCodespaces starts with a private forwarded port and Paperclip sign-in. Provider accounts are connected in the app.");
    return;
  }
  const config = settings();
  if (action === "status") {
    const value = await health(config);
    if (!value || value.status !== "ok" || value.deploymentMode !== "authenticated" || !registeredHere(config)) {
      console.log("Paperclip AWO is not ready. Initial source and native builds can take several minutes.");
      console.log(`Startup log: ${path.join(config.stateDir, "awo-startup.log")}`);
      process.exitCode = 1;
    } else printReady(config, value);
    return;
  }
  if (action === "setup") {
    verifyTools();
    command(pnpmBin, ["install", "--frozen-lockfile"]);
    command(pnpmBin, ["--filter", "@paperclipai/ui", "build"]);
    ensureSecrets(config.stateDir);
    console.log("Dependencies and UI are ready. Run node scripts/awo-dev.mjs start.");
    return;
  }
  if (action === "stop") {
    command(pnpmBin, ["dev:stop", "--data-dir", config.stateDir], { env: runtimeEnvironment(config, {}) });
    return;
  }
  if (!existsSync(path.join(repoRoot, "ui/dist/index.html"))) throw new Error("Run node scripts/awo-dev.mjs setup first.");
  const env = runtimeEnvironment(config, ensureSecrets(config.stateDir));
  await ensurePrivatePort(config);
  const current = await health(config);
  if (current) {
    if (current.deploymentMode !== "authenticated" || !registeredHere(config)) throw new Error(`Port ${config.port} is used by another instance. Stop it or set AWO_PORT.`);
    if (current.status === "ok") printReady(config, current);
    else console.log("This Paperclip instance is still starting. Check node scripts/awo-dev.mjs status.");
    return;
  }
  await requireFreePort(config.port);
  const args = ["dev:once", "--data-dir", config.stateDir, "--bind", "custom", "--bind-host", "127.0.0.1"];
  if (action === "run") {
    const child = spawn(pnpmBin, args, { cwd: repoRoot, env, stdio: "inherit" });
    for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => child.kill(signal));
    child.once("error", (error) => { console.error(error.message); process.exitCode = 1; });
    child.once("exit", (code) => { process.exitCode = code ?? 1; });
    return;
  }
  const logPath = path.join(config.stateDir, "awo-startup.log");
  const log = openSync(logPath, "a", 0o600);
  chmodSync(logPath, 0o600);
  const child = spawn(pnpmBin, args, { cwd: repoRoot, env, detached: true, stdio: ["ignore", log, log] });
  let launchError = null;
  child.once("error", (error) => { launchError = error; });
  child.once("exit", (code, signal) => { launchError = new Error(`The dev runner exited before readiness (${code ?? signal}). See ${logPath}.`); });
  child.unref();
  closeSync(log);
  console.log(`Paperclip is starting. Startup log: ${logPath}`);
  console.log("The first source and native builds can take several minutes.");
  const deadline = Date.now() + 15 * 60_000;
  while (Date.now() < deadline) {
    const value = await health(config);
    if (value?.status === "ok" && value.deploymentMode === "authenticated" && registeredHere(config)) {
      printReady(config, value);
      console.log("Open the app and create your Paperclip account. Connect an AI account in Apps → Connections.");
      return;
    }
    if (launchError) throw launchError;
    await delay(2000);
  }
  throw new Error(`Startup has not become ready after 15 minutes. It may still be building; inspect ${logPath} and run the status command.`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === scriptPath) {
  main().catch((error) => { console.error(`Paperclip AWO: ${error.message}`); process.exitCode = 1; });
}
