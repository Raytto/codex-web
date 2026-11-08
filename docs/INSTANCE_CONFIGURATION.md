# Instance configuration

`server/config.ts` is the sole application `.env` loader. It reads `<cwd>/.env` once before opening the database. Explicit `loadConfig` overrides win over process environment, which wins over `.env`, then documented defaults. Compose mounts the restricted deployment `.env` as `/app/.env`; keep actual credentials there, outside Git. Container environment wins over the mounted file. Change a runtime value and restart/recreate the service; code changes need a rebuild. Brand and base-path changes do not require rebuilding assets.

`server/instance-config.ts` is the shared pure resolver and HTML renderer. `server/instance-environment.ts` is the small public compatibility adapter, not a second file loader: it maps the established `CODEX_WEB_*` host keys to shared internal identifiers, ignores inherited legacy authority keys, and disables the unused credential socket. Empty configuration never selects a private host. Keep public authentication, optional transport/deployment adapters and provider defaults in this edition; synchronize common code from a reviewed source commit, never by copying a private checkout or environment file.

| Setting | Previously | Authoritative setting / default |
| --- | --- | --- |
| Product/title | JSX, page-title and HTML literals | `APP_PRODUCT_NAME`, Codex Web; nonempty <=80 characters, no controls |
| Tagline/login/privacy text | Separate JSX strings | `APP_TAGLINE`, `APP_LOGIN_HINT`, `APP_PRIVACY_NOTE`; generic text <=160 characters |
| Icon/palette | Hardcoded component/CSS | `APP_ICON=bolt` or wrench, `APP_THEME=indigo` or jade; invalid values reject startup |
| Base path | Vite and browser literals | `BASE_PATH`; public template/Compose `/codex-web`, bare code root; absolute slash path without traversal or double slash |
| Binding | Existing server/Compose | `HOST`, `PORT` (1..65535); Compose container port fixed, loopback host port `CWW_BIND_PORT` |
| Data paths | Repeated fallbacks | `APP_STATE_ROOT` (absolute when supplied), explicit `DATA_ROOT`, `TENANT_ROOT`, `PYTHON_RUNTIME_ROOT`; default cwd/data, cwd/tenants, dataRoot/python |
| Compose state mount | Existing deployment setting | `CODEX_WEB_STATE_ROOT`, default ./.state; host path distinct from container paths above |
| Optional host authority | Per-module defaults | `CODEX_WEB_HOST_SOCKET_PATH`, `CODEX_WEB_HOST_TENANT_ROOT`, `CODEX_WEB_KNOWLEDGE_ROOT`, `CODEX_WEB_CODEX_HOME`, `CODEX_WEB_HOST_HOME`, `CWW_DATABASE_PATH`; root service requires all six explicitly |
| Host project seed | Literal | `CODEX_WEB_PROJECT_NAME=host-project`; existing project names stay in SQLite |
| Optional host Python | Existing interpreter override | `CODEX_WEB_SPREADSHEET_PYTHON` absolute executable, empty uses python3 |
| Complete task capacity | New shared durable ownership layer | `MAX_ACTIVE_WORKFLOWS=-1` unlimited, or integer 1..10000; other values reject startup |
| Credentials/providers | Restricted server env | Existing password/session/provider settings; optional integrations stay disabled until their required configuration exists |
| Resource guards | Existing server policy | Existing Job/executor/upload/reader/memory/disk limits; complete-workflow -1 does not disable them |

User accounts, sessions, files, queue ownership, running state and saved model/feature preferences remain in the deployment's database and state directories. `workflow_settings.capacity` is derived from `MAX_ACTIVE_WORKFLOWS` at startup; it is not an independently writable configuration source. Existing resource limit clamps are retained. Boolean queue/isolation values accept true/false or 1/0, empty uses the documented default, other strings reject startup.

The browser receives only productName, tagline, icon, theme, loginHint, privacyNote and basePath through `/api/instance` and escaped inert JSON in initial HTML. Both are no-store. No server paths, tokens, provider settings or whole environment objects are serialized. Icon selection chooses fixed bundled assets. Authentication stays username/password, tenant execution stays isolated, and default Compose does not enable the optional root bridge or mount the Docker socket.

Deployment topology is local operator policy. The public Compose layout, Nginx example and optional host service instructions remain the small explicit adapters; use the same instance values when installing them. Private deployment registries/controllers and service identities are not published. See [deployment options](DEPLOYMENT_OPTIONS.md) for the host/container path distinction and permission requirements.

Upgrade adds complete workflow migrations but does not move existing files or data roots. Record the previous image and matching verified backup before upgrade. Roll back code through the existing deployment procedure; older code ignores new brand keys. Reverting a database is a separate recovery decision that can discard newer user work. See [complete tasks](COMPLETE_WORKFLOWS.md) and [build/rollback](BUILD_AND_STORAGE.md).

The public Compose adapter mounts the existing state-root `cold-storage` directory alongside data and tenants so local reader deletion can take its locks under a read-only container root. The network-disabled initializer owns only the cold-state/lock directories for the Web UID, without recursively changing archive ownership. It does not enable a cloud provider or move existing data. Health checks derive their route from the effective BASE_PATH, including custom and root prefixes.
