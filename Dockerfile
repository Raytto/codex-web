FROM node:22-bookworm-slim AS source

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
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

FROM source AS test
COPY .github ./.github
COPY README.md ./README.md
COPY docs ./docs
RUN apt-get update \
    && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends git python3 \
    && rm -rf /var/lib/apt/lists/* \
    && npm --prefix remote-worker ci \
    && npm run verify

FROM source AS build
RUN npm run build && npm prune --omit=dev

FROM source AS worker-release
ARG WORKER_RELEASE_COMMIT=0000000000000000000000000000000000000000
RUN apt-get update \
    && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends zip \
    && rm -rf /var/lib/apt/lists/* \
    && npm --prefix remote-worker ci \
    && npm --prefix remote-worker run build \
    && npm --prefix remote-worker prune --omit=dev \
    && remote-worker/scripts/build-release-package.sh /app/worker-release "$WORKER_RELEASE_COMMIT"

FROM node:22-bookworm-slim AS codex-baked
ARG CODEX_CLI_VERSION=latest
RUN npm install --global --prefix /opt/codex-baked "@openai/codex@${CODEX_CLI_VERSION}" \
    && /opt/codex-baked/bin/codex --version

FROM node:22-bookworm-slim AS runtime

ARG UV_VERSION=0.11.28
RUN apt-get update \
    && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
      bash bubblewrap ca-certificates curl ffmpeg fontconfig fonts-liberation fonts-noto-cjk git \
      libreoffice-calc libreoffice-impress libreoffice-writer poppler-utils tini \
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
COPY scripts ./scripts
COPY skills ./skills
COPY account-resources ./account-resources

# Build artifacts can inherit restrictive source-file modes (notably favicon).
# The unprivileged runtime user must be able to serve every public asset.
RUN chmod -R a+rX /app/dist

ENV NODE_ENV=production \
    HOME=/home/cww \
    CODEX_HOME=/home/cww/.codex \
    PYTHON_RUNTIME_ROOT=/opt/cww-python \
    PYTHON_VERSION=3.12 \
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
