FROM node:26-bookworm-slim AS source

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY index.html tsconfig*.json vite.config.ts ./
COPY compose.yaml ./
COPY src ./src
COPY server ./server
COPY tests ./tests

FROM source AS test
RUN apt-get update \
    && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends git \
    && rm -rf /var/lib/apt/lists/* \
    && npm test

FROM source AS build
RUN npm run build && npm prune --omit=dev

FROM node:26-bookworm-slim AS codex-baked
ARG CODEX_CLI_VERSION=latest
RUN npm install --global --prefix /opt/codex-baked "@openai/codex@${CODEX_CLI_VERSION}" \
    && /opt/codex-baked/bin/codex --version

FROM node:26-bookworm-slim AS runtime

ARG UV_VERSION=0.11.28
RUN apt-get update \
    && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
      acl bash bubblewrap ca-certificates curl ffmpeg fontconfig fonts-liberation fonts-noto-cjk git \
      libreoffice-calc libreoffice-impress libreoffice-writer poppler-utils tini \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/dist-server ./dist-server
COPY --from=codex-baked /opt/codex-baked /opt/codex-baked
COPY package.json ./
COPY python-runtime ./python-runtime
COPY scripts ./scripts

ENV NODE_ENV=production \
    HOME=/home/cww \
    CODEX_HOME=/home/cww/.codex \
    PYTHON_RUNTIME_ROOT=/opt/cww-python \
    PYTHON_VERSION=3.12 \
    TZ=Asia/Shanghai

RUN chmod 0755 scripts/*.sh \
    && PYTHON_RUNTIME_ROOT=/opt/cww-python UV_VERSION="$UV_VERSION" ./scripts/setup-python.sh \
    && rm -rf /opt/cww-python/cache \
    && ln -s /app/scripts/codex-runtime.sh /usr/local/bin/codex \
    && groupadd --gid 10001 cww \
    && useradd --uid 10001 --gid 10001 --create-home --shell /bin/bash cww \
    && groupadd --gid 11001 cww-owner \
    && useradd --uid 11001 --gid 11001 --home-dir /app/tenants/00000000-0000-4000-8000-000000000001 --no-create-home --shell /usr/sbin/nologin cww-owner \
    && mkdir -p /app/data /app/tenants /home/cww/.codex \
    && chown -R 10001:10001 /app/data /app/tenants /home/cww

USER 0:0
EXPOSE 37821
CMD ["/app/scripts/start-supervisor.sh"]
