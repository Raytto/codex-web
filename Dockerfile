FROM node:22-bookworm-slim AS source

WORKDIR /app
ARG NODE_OPTIONS=--max-old-space-size=1536
ENV NODE_OPTIONS=$NODE_OPTIONS
COPY package.json package-lock.json ./
RUN npm ci && npm cache clean --force
COPY index.html tsconfig*.json vite.config.ts ./
COPY Dockerfile ./Dockerfile
COPY compose.yaml ./
COPY public ./public
COPY src ./src
COPY server ./server
COPY tests ./tests
COPY deploy ./deploy
COPY skills ./skills
COPY account-resources ./account-resources
COPY remote-worker ./remote-worker
COPY scripts ./scripts

FROM source AS test
COPY .github ./.github
COPY README.md ./README.md
COPY docs ./docs
RUN mkdir -p /etc/ssl/certs \
    && node -e 'require("fs").writeFileSync("/etc/ssl/certs/ca-certificates.crt", require("tls").rootCertificates.join("\n"))' \
    && sed -i 's|http://deb.debian.org|https://deb.debian.org|g' /etc/apt/sources.list.d/debian.sources \
    && apt-get update \
    && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends git python3 \
    && rm -rf /var/lib/apt/lists/* \
    && npm --prefix remote-worker ci \
    && npm run verify

FROM source AS build
RUN npm run build && npm prune --omit=dev

FROM source AS worker-release
ARG WORKER_RELEASE_COMMIT
RUN test -n "$WORKER_RELEASE_COMMIT" || (echo "Set WORKER_RELEASE_COMMIT to the reviewed source SHA; scripts/build-image.sh supplies it automatically" >&2; exit 2)
RUN mkdir -p /etc/ssl/certs \
    && node -e 'require("fs").writeFileSync("/etc/ssl/certs/ca-certificates.crt", require("tls").rootCertificates.join("\n"))' \
    && sed -i 's|http://deb.debian.org|https://deb.debian.org|g' /etc/apt/sources.list.d/debian.sources \
    && apt-get update \
    && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends zip \
    && rm -rf /var/lib/apt/lists/* \
    && npm --prefix remote-worker ci \
    && npm --prefix remote-worker run build \
    && npm --prefix remote-worker prune --omit=dev \
    && remote-worker/scripts/build-release-package.sh /app/worker-release "$WORKER_RELEASE_COMMIT"

FROM node:22-bookworm-slim AS codex-baked
ARG CODEX_CLI_VERSION=0.162.1
RUN npm install --global --prefix /opt/codex-baked "@openai/codex@${CODEX_CLI_VERSION}" \
    && /opt/codex-baked/bin/codex --version \
    && npm cache clean --force

FROM node:22-bookworm-slim AS runtime-base

ARG UV_VERSION=0.11.28
ARG PYTHON_VERSION=3.12.12
RUN mkdir -p /etc/ssl/certs \
    && node -e 'require("fs").writeFileSync("/etc/ssl/certs/ca-certificates.crt", require("tls").rootCertificates.join("\n"))' \
    && sed -i 's|http://deb.debian.org|https://deb.debian.org|g' /etc/apt/sources.list.d/debian.sources \
    && apt-get update \
    && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
      acl bash bubblewrap ca-certificates curl ffmpeg git tini \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/dist-server ./dist-server
COPY --from=worker-release /app/worker-release ./worker-release
COPY --from=codex-baked /opt/codex-baked /opt/codex-baked
COPY package.json ./
COPY --from=build /app/remote-worker/package.json ./remote-worker/package.json
COPY python-runtime ./python-runtime
# Ship only Linux runtime/setup entrypoints; browser checks stay in source/test.
COPY scripts/codex-runtime.sh scripts/hash-password.mjs \
     scripts/migrate-tenant-permissions.sh scripts/run-python-task.sh \
     scripts/setup-python.sh scripts/start-supervisor.sh ./scripts/
COPY skills ./skills
COPY account-resources ./account-resources

# Build artifacts can inherit restrictive source-file modes (notably favicon).
# The unprivileged runtime user must be able to serve every public asset.
RUN chmod -R a+rX /app/dist

ENV NODE_ENV=production \
    HOME=/home/cww \
    CODEX_HOME=/home/cww/.codex \
    PYTHON_RUNTIME_ROOT=/opt/cww-python \
    PYTHON_VERSION=${PYTHON_VERSION} \
    TZ=Asia/Shanghai

RUN chmod 0755 scripts/*.sh \
    && chmod -R a+rX /app/skills /app/account-resources \
    && PYTHON_RUNTIME_ROOT=/opt/cww-python UV_VERSION="$UV_VERSION" ./scripts/setup-python.sh \
    && rm -rf /opt/cww-python/cache \
    && ln -s /app/scripts/codex-runtime.sh /usr/local/bin/codex \
    && groupadd --gid 10001 cww \
    && useradd --uid 10001 --gid 10001 --create-home --shell /bin/bash cww \
    && groupadd --gid 11001 cww-owner \
    && useradd --uid 11001 --gid 11001 --home-dir /app/tenants/00000000-0000-4000-8000-000000000001 --no-create-home --shell /usr/sbin/nologin cww-owner \
    && groupadd --gid 11002 cww-member-a \
    && useradd --uid 11002 --gid 11002 --home-dir /app/tenants/00000000-0000-4000-8000-000000000002 --no-create-home --shell /usr/sbin/nologin cww-member-a \
    && groupadd --gid 11003 cww-member-b \
    && useradd --uid 11003 --gid 11003 --home-dir /app/tenants/00000000-0000-4000-8000-000000000003 --no-create-home --shell /usr/sbin/nologin cww-member-b \
    && mkdir -p /app/data /app/tenants /home/cww/.codex \
    && chown -R 10001:10001 /app/data /app/tenants /home/cww

USER 0:0
EXPOSE 37821
CMD ["/app/scripts/start-supervisor.sh"]

# Opt in with CODEX_WEB_BUILD_TARGET=documents. The final/default target stays lean.
FROM runtime-base AS documents
RUN apt-get update \
    && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
      fontconfig fonts-liberation fonts-noto-cjk libreoffice-calc libreoffice-impress \
      libreoffice-writer poppler-utils \
    && rm -rf /var/lib/apt/lists/* \
    && PYTHON_RUNTIME_PROFILE=documents /app/scripts/setup-python.sh \
    && rm -rf /opt/cww-python/cache
ENV CODEX_WEB_TOOL_PROFILE=documents

FROM runtime-base AS runtime
ENV CODEX_WEB_TOOL_PROFILE=base
