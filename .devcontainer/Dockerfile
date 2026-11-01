# syntax=docker/dockerfile:1
FROM mcr.microsoft.com/devcontainers/javascript-node:24-trixie

USER root
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
      build-essential pkg-config libssl-dev python3 ca-certificates curl gh lsof \
    && rm -rf /var/lib/apt/lists/* \
    && npm install --global --force --omit=dev \
      pnpm@9.15.4 @openai/codex@0.160.0 @anthropic-ai/claude-code@2.1.277 \
    && test "$(pnpm --version)" = 9.15.4

# Use the same verified rustup installer and package-owned compiler as upstream.
# No debugging capabilities or relaxed seccomp profile are needed to build it.
ENV RUSTUP_HOME=/usr/local/rustup \
    CARGO_HOME=/usr/local/cargo \
    PATH=/usr/local/cargo/bin:$PATH
ARG RUSTUP_VERSION=1.29.0
ARG RUSTUP_SHA256_AMD64=4acc9acc76d5079515b46346a485974457b5a79893cfb01112423c89aeb5aa10
ARG RUSTUP_SHA256_ARM64=9732d6c5e2a098d3521fca8145d826ae0aaa067ef2385ead08e6feac88fa5792
RUN set -eu; \
    case "$(dpkg --print-architecture)" in \
      amd64) rustTarget=x86_64-unknown-linux-gnu; checksum="$RUSTUP_SHA256_AMD64" ;; \
      arm64) rustTarget=aarch64-unknown-linux-gnu; checksum="$RUSTUP_SHA256_ARM64" ;; \
      *) echo "Unsupported Rust architecture" >&2; exit 1 ;; \
    esac; \
    curl -fsSLo /tmp/rustup-init "https://static.rust-lang.org/rustup/archive/${RUSTUP_VERSION}/${rustTarget}/rustup-init"; \
    echo "$checksum  /tmp/rustup-init" | sha256sum -c -; \
    chmod +x /tmp/rustup-init; \
    /tmp/rustup-init -y --no-modify-path --profile minimal --default-toolchain none; \
    rm /tmp/rustup-init; \
    chown -R node:node /usr/local/rustup /usr/local/cargo

COPY --chown=node:node packages/paperclip-runner/rust-toolchain.toml /tmp/awo-toolchain/rust-toolchain.toml
USER node
RUN cd /tmp/awo-toolchain && rustup show
