# Paperclip AWO setup

This guide is for [Krish-CXO/paperclipAWO](https://github.com/Krish-CXO/paperclipAWO).
The repository contains the application and its launch configuration. A running instance also needs a computer or Codespace, an owner account, and an AI provider connection.

## Choose where to run it

| Option | Use it for | What you need |
| --- | --- | --- |
| GitHub Codespaces | Trying and developing Paperclip in your browser | GitHub Codespaces access and available usage allowance or billing |
| Local Docker | A persistent instance on your Mac or Linux computer | Docker Desktop/Engine, Compose v2, Git, Node.js 24.11+ |
| Local source | Developing the application without Docker | Node.js 24.11+, pnpm 9.15.4, Rust 1.97.1 through rustup, Python 3, compiler tools |

All three AWO launch paths require Paperclip sign-in. Local listeners bind to loopback. Codespaces also requires a private forwarded port.

## GitHub Codespaces

1. [Open this repository in Codespaces](https://codespaces.new/Krish-CXO/paperclipAWO?ref=master).
2. Review the machine and billing information, then create the Codespace.
3. Allow the initial container build and dependency installation to finish. The first native runner build can take several minutes.
4. In the terminal, run `node scripts/awo-dev.mjs status`. When it reports `ok`, open **Ports → 3100 → Open in Browser**.
5. Complete the account and provider setup below.

The devcontainer installs the required tools. Its creation hook installs locked dependencies and builds the UI; its start hook starts Paperclip. Startup explicitly sets port 3100 to private and stops with an error if GitHub cannot apply that setting.

For a Codespace created before this configuration was added, back up its data, update the checkout, and rebuild the development container to apply the required tools and startup hooks.

Data lives in `/workspaces/.paperclip-awo`, outside the Git checkout. It survives a container rebuild while the Codespace exists. Deleting the Codespace removes this data. Back it up before deletion.

Codespaces can stop when idle and is not an always-on server. Compute and storage count against your GitHub allowance or billing. Stop the Codespace when finished; stopping only Paperclip does not stop the Codespace.

## Local Docker

Start Docker Desktop or Docker Engine, then clone this fork:

```sh
git clone https://github.com/Krish-CXO/paperclipAWO.git
cd paperclipAWO
node scripts/awo-docker.mjs start
```

If you already cloned it, run the last command from that folder. The launcher generates two independent signing secrets once, builds the self-hosted image, starts it, and checks the database-backed health endpoint. It preserves existing secrets on later starts.

Open <http://localhost:3100>. Docker stores the database, uploads, encryption key, and agent workspaces in the named volume `paperclip-awo-data`. Private launch configuration is in `docker/.env.awo`; Git and the Docker build context exclude it.

Useful commands:

```sh
node scripts/awo-docker.mjs status
node scripts/awo-docker.mjs logs
node scripts/awo-docker.mjs stop
```

`stop` retains the data volume. The container restarts with Docker unless you stopped it. To change the host port, edit `PAPERCLIP_PORT` in `docker/.env.awo` and run `start` again. Provider keys are optional in that file; connecting accounts in the app is the normal path.

## Local source

Install the tools listed above first. The repository pins Rust in `packages/paperclip-runner/rust-toolchain.toml`. On macOS, native builds also require the Xcode command-line tools. On Linux, install a C/C++ toolchain, `pkg-config`, and OpenSSL development headers.

From the cloned repository:

```sh
node scripts/awo-dev.mjs setup
node scripts/awo-dev.mjs start
node scripts/awo-dev.mjs status
```

Open <http://localhost:3100> when status reports `ok`. Use `node scripts/awo-dev.mjs run` instead of `start` to keep the server in the current terminal. Use `node scripts/awo-dev.mjs stop` for a graceful stop.

The default data directory is `~/.paperclip-awo`. Startup output is in `~/.paperclip-awo/awo-startup.log`. Set `AWO_DATA_DIR` to a different absolute directory outside the repository if needed; use the same value for every command. Set `AWO_PORT` to use another port.

The source launcher does not install an operating-system service. After a computer restart, run `start` again. Local source installs also need the selected provider CLI on the host for subscription sign-in; Codespaces and Docker include Claude Code and Codex CLIs. See [provider setup](DOCKER.md#claude--codex-local-adapters-in-docker).

## Create your owner account and connect AI

1. Open the running app and create or sign into your Paperclip account.
2. On a fresh instance, choose **Claim this instance** to establish the first administrator.
3. Create your company, for example **AWO**, and set its goal.
4. In **Apps → Connections**, connect your Claude or Codex subscription, or enter a supported provider API key.
5. Create your first agent, select the connected account and model, and set a budget before assigning work.
6. Run one small task and confirm its output and cost in the dashboard.

The launch scripts create no active agent team or first task. A healthy dashboard does not prove that a provider is connected. Enter credentials through the app or private configuration; never put them in a Git commit.

## Preserve and back up the instance

Back up the entire data directory or Docker volume, together with its signing secrets. Database dumps alone omit uploads, workspaces, and the local encryption key needed to decrypt saved credentials.

| Installation | Retain together |
| --- | --- |
| Docker | `paperclip-awo-data` volume and `docker/.env.awo` |
| Local source | Entire `~/.paperclip-awo`, or your `AWO_DATA_DIR` |
| Codespaces | Entire `/workspaces/.paperclip-awo`, copied somewhere outside the Codespace |

Stop Paperclip before making a full filesystem or volume copy. Store the copy privately. Restore the complete matching data and secret set; do not replace missing signing secrets with new values. Never delete the Docker volume or Codespace as an update step.

Docker enables hourly logical database backups with 30-day retention inside its persistent volume. Those copies help with database recovery but do not protect against loss of that volume. See [database backups](DATABASE.md#backups).

## Update and diagnose

Before an update, make a full backup and stop Paperclip. Review the proposed fork/upstream changes, update your checkout, then rerun `node scripts/awo-dev.mjs setup` and `start`, or `node scripts/awo-docker.mjs start` for Docker. Startup may apply database migrations; restoring older application code alone may not reverse a migration.

If startup fails, inspect the source startup log or Docker `logs` command. Check `status` after the error is resolved. Do not generate replacement secrets or delete the database to fix an installation error.

For Codespaces, keep the forwarded port private. These defaults do not configure a public internet deployment, a custom domain, or an always-on cloud host. Those require separate hosting and HTTPS configuration; see [deployment modes](DEPLOYMENT-MODES.md).
