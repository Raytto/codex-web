import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { HOST_ROOT_USERNAME } from "../server/host-root-user.js";
import { listTenantIdentities, WEB_IDENTITY } from "../server/tenant-identities.js";

const root = process.cwd();
const read = (relativePath: string) => fs.readFileSync(path.join(root, relativePath), "utf8");

test("production documentation follows managed deployment and current persistence invariants", () => {
  const readme = read("README.md");
  const deployment = read("docs/DEPLOYMENT.md");
  const architecture = read("docs/ARCHITECTURE.md");
  const security = read("docs/SECURITY.md");
  const compose = read("compose.yaml");

  for (const document of [readme, deployment]) {
    assert.doesNotMatch(document, /^\s*(?:sudo\s+)?docker compose[^\n]*(?:\bbuild\b|\bup\b[^\n]*--build)/m);
    assert.match(document, /codex-web-self-maintain\.service/);
    assert.match(document, /codex-web-request-rebuild/);
  }
  for (const mount of ["/data:/app/data", "/tenants:/app/tenants", "/codex-runtime}:/opt/codex-runtime"]) {
    assert.ok(compose.includes(mount), `compose must retain the current ${mount} mount`);
  }
  assert.match(architecture, /`tenants\/<user-id>\/conversations\/`/);
  assert.doesNotMatch(architecture, /^\| `(?:workspaces|codex-home)\/`/m);
  assert.match(deployment, /旧布局/);

  const accountNames = [...listTenantIdentities().map((identity) => identity.label), HOST_ROOT_USERNAME];
  for (const account of accountNames) assert.match(security, new RegExp(`\\b${account}\\b`));
  assert.match(security, new RegExp(`UID/GID ${WEB_IDENTITY.uid}`));
  assert.match(security, /supervisor/);
});

test("Remote Worker edge template keeps transfer secrets out of request-target logs", () => {
  const nginx = read("deploy/nginx/codex-web.conf");
  assert.match(nginx, /log_format\s+codex_web_remote_worker[^;]*\$uri/s);
  const format = nginx.match(/log_format\s+codex_web_remote_worker([\s\S]*?);/)?.[1] ?? "";
  assert.doesNotMatch(format, /\$args|\$request_uri/);
  assert.match(nginx, /client_max_body_size\s+100m/);
  assert.match(nginx, /limit_conn\s+codex_web_remote_worker_connections\s+8/);
  assert.match(nginx, /limit_req\s+zone=codex_web_remote_worker_transfers/);
  assert.match(nginx, /proxy_set_header\s+Upgrade\s+""/);
  assert.equal((nginx.match(/proxy_set_header\s+Connection\s+"close"/g) ?? []).length >= 2, true);
});
