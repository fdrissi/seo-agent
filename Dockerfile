# syntax=docker/dockerfile:1
#
# OPTIONAL container build for seo-agent. The supported installation path is
# Node.js + npm (see README/docs); this image is a convenience for servers.
#
# Safety properties:
# - The build context is restricted by the .dockerignore ALLOWLIST (deny all,
#   then re-include package manifests, src, migrations, the build-stamp script
#   (scripts/write-build-info.mjs), prompts, the vault
#   template, the synthetic example config, and the SYNTHETIC fixtures in
#   tests/fixtures that the demo reads at runtime). Private workspaces, .env
#   files, secrets, vaults, databases, logs, and backups cannot enter the image.
#   `npm run release:check` verifies this against the real directory contents.
# - The private workspace is NEVER baked into the image: mount it as a volume at
#   /workspace. Upgrading the image never touches the workspace; the database
#   changes only through checksummed migrations with a pre-migration backup.
# - Secrets are provided at runtime (for example `--env-file <workspace>/secrets/secrets.env`
#   or the mounted workspace secrets file), never with ARG/ENV at build time.
# - Dependencies are installed from the lockfile with --ignore-scripts.
# - Runs as the unprivileged `node` user.
#
# TODO(owner): pin the base image by digest (node:24-bookworm-slim@sha256:...)
# after verifying it; see docs/RELEASING.md. Not pinned here because the digest
# could not be verified offline.
#
# Build:  docker build -t seo-agent:local .
# Run:    docker run --rm -it -v "$HOME/seo-agent-workspace:/workspace" seo-agent:local doctor
# Note:   inside the container 127.0.0.1 is the container itself. Point QDRANT_URL
#         at the Qdrant service (for example the compose service name) and keep
#         Qdrant off public networks (see docs/SECURITY_MODEL.md).

ARG NODE_IMAGE=node:24-bookworm-slim

FROM ${NODE_IMAGE} AS build
WORKDIR /app
ENV npm_config_ignore_scripts=true npm_config_audit=false npm_config_fund=false npm_config_update_notifier=false
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
# `npm run build` is `tsc -p tsconfig.build.json && node scripts/write-build-info.mjs`.
# The stamp script (node built-ins only) writes dist/build-info.json with the source hash
# and the migrations/ list; without migrations/ here the stamp would record
# `"migrations": null` and the container would skip every build/migration freshness
# check. `npm run release:check` verifies these build-stage inputs ("docker-build-inputs").
COPY scripts/write-build-info.mjs ./scripts/write-build-info.mjs
COPY migrations ./migrations
RUN npm run build

FROM ${NODE_IMAGE} AS runtime-deps
WORKDIR /app
ENV npm_config_ignore_scripts=true npm_config_audit=false npm_config_fund=false npm_config_update_notifier=false
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force

FROM ${NODE_IMAGE} AS runtime
LABEL org.opencontainers.image.title="seo-agent" \
      org.opencontainers.image.description="Self-hosted SEO/AEO/content intelligence agent (optional container build). Mount your private workspace at /workspace."
ENV NODE_ENV=production \
    SEO_AGENT_WORKSPACE=/workspace
WORKDIR /app
COPY --from=runtime-deps /app/package.json /app/package-lock.json ./
COPY --from=runtime-deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY migrations ./migrations
COPY prompts ./prompts
COPY vault/_template ./vault/_template
COPY config/sites/example.site.yaml ./config/sites/example.site.yaml
# SYNTHETIC fixtures used at runtime by `demo` and the Demo profile (appDirs.fixtures()).
# Without them `docker run ... demo` cannot run. `npm run release:check` verifies this line.
COPY tests/fixtures ./tests/fixtures
# The project LICENSE (MIT) and the third-party notices travel with the image and the
# redistributed node_modules (several runtime dependencies ship no LICENSE file of their
# own). Both are re-included by the .dockerignore allowlist; `npm run release:check`
# verifies that. The bracket wildcards keep the COPY tolerant if either is ever missing.
# NOTE: optional-wildcard COPY behavior was not verified with a real Docker build here.
COPY package.json THIRD_PARTY_NOTICES.m[d] LICENS[E]* ./
RUN mkdir -p /workspace && chown node:node /workspace && chmod 700 /workspace
USER node
VOLUME ["/workspace"]
ENTRYPOINT ["node", "dist/cli/main.js"]
CMD ["--help"]
