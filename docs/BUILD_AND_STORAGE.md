# Building, capacity and safe cleanup

Compose first runs the network-disabled `init-state` service against only the application data/tenant mounts. It fixes ownership and ACLs, then exits. The regular supervisor retains only SETUID/SETGID/KILL capabilities; file ownership/DAC initialization capabilities do not remain in that process. Both services share the same image.

The default `runtime` target is the base application. It contains Node, the web/API service, an independent low-privilege tenant worker, one pinned Codex CLI, Git, bubblewrap, FFmpeg and a managed Python interpreter with its standard library and uv. Browser dependencies and Codex SDK **types** are build dependencies: the browser bundle is served from `dist`, and the server starts the separate CLI. The runtime does not need a second SDK-installed CLI.

The `documents` target adds LibreOffice Writer/Calc/Impress, Poppler, CJK/Liberation fonts and the locked Python document/data packages (including pandas, matplotlib, openpyxl, python-docx, python-pptx and PDF libraries). It is optional. The base profile reports missing tools to the agent; Python packages can be installed for one task using `CWW_PYTHON_RUNNER` and are removed with that task's temporary environment. Offline tasks must report unavailable dependencies. System office conversion requires the documents image. FFmpeg stays in both profiles so configured voice processing retains its conversion behavior. Neither profile supplies model weights, an account login or user content.

## New production installation

Use a reviewed `main` commit. Only Docker Engine, Compose v2, Buildx and Git are required on the host; Node/npm and a host Python environment are unnecessary for the base container installation.

```bash
git clone --branch main https://github.com/Raytto/codex-web.git
cd codex-web
./scripts/build-image.sh
cp .env.example .env
chmod 600 .env
```

`build-image.sh` archives only the chosen Git commit, uses a uniquely named Buildx builder, limits build concurrency to one, bounds the builder at 3 GiB, and removes that builder and its cache on success or failure. It never invokes global prune. The default image is `codex-web:local`; `CODEX_WEB_IMAGE` may set a unique tag. Untracked local state cannot enter the Git archive, and `.dockerignore` additionally uses an allowlist. Tracked local edits must be committed or preserved before building.

Generate the password hash from the **already built** application image. In an interactive Bash terminal, use silent input; the password is passed through stdin and never placed in command arguments:

```bash
read -r -s -p 'Web password (at least 12 characters): ' web_password
printf '\n'
printf '%s' "$web_password" | docker run --rm -i --network none \
  --entrypoint node codex-web:local scripts/hash-password.mjs
unset web_password
```

Store the resulting bcrypt hash and an independently generated session secret in the private `.env`. Never log or commit either. On Linux Docker Engine, give only the web UID read access after editing:

```bash
sudo chown 10001:10001 .env
sudo chmod 600 .env
```

The root supervisor does not load secrets into every worker's environment; the web process reads this file after dropping to UID 10001, while tenant UID 11001 cannot read it. Edit it later with a privileged editor, and run subsequent Compose commands with `sudo` (or as host root) so Compose can read the owner-only file. Then follow the README network, startup and tenant login steps, using `docker compose up -d --no-build`. Raw `docker build --target runtime` must include `--build-arg WORKER_RELEASE_COMMIT="$(git rev-parse HEAD)"`; missing source identity fails the build before producing an unusable Worker manifest. A custom image tag must also be exported as `CODEX_WEB_IMAGE` for Compose. The helper reads shell environment variables, **not** Compose's `.env`; pass build options explicitly.

For the office profile:

```bash
CODEX_WEB_BUILD_TARGET=documents CODEX_WEB_IMAGE=codex-web:documents ./scripts/build-image.sh
sudo env CODEX_WEB_IMAGE=codex-web:documents docker compose up -d --no-build
```

Set that image choice persistently in the deployment's `.env` before future `up` operations. For direct Compose builds, `sudo env WORKER_RELEASE_COMMIT="$(git rev-parse HEAD)" CODEX_WEB_BUILD_TARGET=documents docker compose build` also selects the extra tools, but uses the engine's shared build cache and does not perform the helper's isolated cleanup. Do not treat its retained cache as the application's steady-state footprint.

## Development and release verification

Release maintainers run `npm ci`, `npm --prefix remote-worker ci`, `npm run verify`, full dependency audits and the Docker `test` target. Ordinary production installs need not install host development dependencies or load a test image. The optional host self-maintenance coordinator separately needs Python 3, systemd and curl, alongside Git/Docker/Compose/Buildx.

To independently verify a source build on the deployment host:

```bash
CODEX_WEB_VERIFY_BUILD=1 ./scripts/build-image.sh
```

This runs the same Docker test stage before building the application. No tagged test image is loaded; the dedicated builder's test layers are removed at the end. Allow additional time, disk and memory. On a 4 GiB server, stop or schedule around application workloads while building; swap can prevent memory exhaustion but is **host capacity**, not image content. Do not remove a working swapfile to meet an application disk target. A larger separate build host is another option; transfer/pull the exact reviewed image and record its digest.

`CODEX_CLI_VERSION` defaults to `0.162.1`; only a numeric version is accepted by the helper. `UV_VERSION` and the managed Python patch version are pinned in the Dockerfile. The Node base is a tag, so record its resolved digest, platform, source SHA and build arguments for every capacity comparison. A later OS package/base refresh may change byte totals; exact bit-for-bit reproduction additionally requires a fixed base digest and package repository snapshot.

## Disk accounting

A 2–3 GB target is for the **base application after build cleanup**, excluding OS/Docker installation, swap, backups and user-generated state. It is not a promise that a complete cloud server or arbitrary user workload will never exceed 3 GB. Budget substantially more free space during builds, tests, upgrades and restore drills; old and new versions may temporarily coexist. The deployment report must record these separately:

| Category | What to measure |
| --- | --- |
| Image logical size | `docker image inspect IMAGE --format '{{.Size}}'`: uncompressed sum of image layers, not download size |
| Resident image layers | Unique layers stored by Docker; shared layers counted once, including runtime/documents/rollback images if retained |
| Build peak and cache | Dedicated builder state during the build, temporary exports and engine build cache; peak exceeds final image size |
| Test images | Separate test tags if explicitly loaded; their source and dev dependencies are unnecessary in production |
| Host dependencies | Docker, Git, reverse proxy, optional development `node_modules`, npm/uv caches |
| Codex runtime | The image contains one CLI; default startup does not copy it into `.state/codex-runtime` |
| User state | `.state/data` contains SQLite/conversation/task metadata; `.state/tenants` contains login/thread state, uploads, project code and outputs |
| Backup and restore drill | Encrypted backups and temporary restored copies, counted separately |
| OS and swap | Whole-server costs independent of application image size; record actual swapfile size and memory policy |

`docker system df -v` is useful for ownership/shared-size information; **do not add its image and cache columns blindly**. For a clean measurement use an empty, isolated Docker data root and empty application state, record filesystem allocated bytes at each stage, and retain the maximum observed build usage. Sampling provides an observed peak, not a theoretical upper bound. Include the check interval and measurement limitations.

### Measured clean-install example (2026-10-14)

On Linux amd64, using Codex CLI 0.162.1 and separate initially empty Docker storage for each run, the previous public commit `c727d8d` was compared with this revision. GB below means 1,000,000,000 bytes; allocated totals use filesystem blocks, not sums of Docker's overlapping columns.

| Measurement | Previous guide / image | New default |
| --- | ---: | ---: |
| Application image logical bytes | 2,870,889,665 (2.871 GB) | 1,534,722,331 (1.535 GB) |
| Docker allocated after build | 5,118,734,336 | 1,857,548,288 |
| Host development dependencies + npm cache | 1,176,895,488 | 0 required |
| Persistent duplicate CLI | 452,710,400 | Empty directory only (4,096) |
| Application install allocated total | 6,754,418,688 (6.754 GB) | 1,869,692,928 (1.870 GB) |
| Observed Docker build peak, sampled every 10 s | 5,384,486,912 | 6,006,992,896 |

The new total includes the retained BuildKit infrastructure image (249,122,687 logical bytes), the source Git checkout (9,093,120 allocated bytes), and synthetic initial state (3,047,424 bytes after login/basic setup). It excludes host OS/Docker/Git installation, swap, backups and user workloads. The old source was an archive, so its total excludes Git history. The old flow retained its test image and shared build cache and installed host npm dependencies. Its initial startup also needed isolated permission/source-identity repairs to reach health; those repairs are now part of the default flow. Both image comparisons used the same CLI version; baseline apt transport was adjusted to HTTPS without changing its package set.

The image is about 46.5% smaller and this measured base installation about 72.3% smaller. The build peak did **not** fall: the isolated builder and image export temporarily keep additional copies. Reserve at least 10 GB free for a base build in a comparable environment, and more for optional tests/documents, upgrades, rollback images and data; this is planning guidance, not a maximum guarantee. No swap was created or removed in this measurement. Later base/package updates, filesystem allocation and source history can change exact totals. The optional documents image measured 2,270,205,535 logical bytes (2.270 GB). Building it with the optional full test stage while retaining the previous base image reached an observed Docker peak of 9,507,487,744 bytes (9.507 GB); both independently built profiles plus BuildKit occupied 3,983,851,520 allocated bytes after cleanup. That is a separate multi-image/verification scenario, not the default installation. Independent builds can share only some layers; keep this in the rollback/optional-profile budget.

Useful read-only inventory on an existing installation:

```bash
docker system df -v
docker compose images
docker compose ps
docker image inspect codex-web:local --format '{{.Id}} {{.Size}}'
du -sh .state/data .state/tenants .state/codex-runtime 2>/dev/null
swapon --show --bytes
```

## New deployment closeout

1. Confirm health, username/password login under `/codex-web`, tenant identity, a harmless task and file delivery. Record source SHA, image ID/profile, layer accounting, empty-state size and observed build peak.
2. The build helper removes only its unique builder and cache. If interrupted so its EXIT trap could not run, identify the exact `codex-web-build-TIMESTAMP-PID` name in that run's log, inspect it, and remove **that builder only** with `docker buildx rm NAME`. Do not remove other builders or use `docker system prune`, `docker builder prune` or volume prune.
3. If an older guide created `codex-web-test:preflight` or `codex-web-test:upgrade`, inspect the exact image and run `docker ps -a --filter ancestor=EXACT_IMAGE_ID`. If unused and owned by this deployment, remove the exact test tag with `docker image rm TAG` (no force). Shared layers remain while referenced. Do not confuse an active/rollback application tag with a test tag.
4. A legacy shared default-builder cache cannot be safely assigned to this installation by age alone. Keep it unless individual ownership is independently established. The dedicated-builder workflow prevents this ambiguity for new builds.
5. Restore drills use a uniquely named temporary directory/project, a separate state root and a separate port. After successful restore verification, stop and remove **only** that drill container/project, confirm no mount/process uses its exact temporary directory, then delete that directory. Preserve the original state, the verified encrypted backup, its checksum and recovery key in its safe location. Never delete the only recoverable copy merely because the drill passed.
6. Keep one known-good rollback image plus its matching backup through upgrade acceptance. Remove an obsolete exact tag only after the retention decision and container-reference check. Shared images do not consume their full logical size twice.

## Upgrade and rollback

Back up `.env` and all active state using the backup procedure, record the old image ID and retain it under a unique rollback tag, review `git log HEAD..origin/main`, and select the reviewed target commit. Build with the helper, then `docker compose up -d --no-build`. Repeat closeout and functional checks. Stop gracefully; do not replace an active database with a test fixture. Migrations for voice submissions (`2026101401`) and opportunity cards (`2026101402`) are additive; rollback to an older application requires its matching pre-upgrade state backup.

The default `CWW_CODEX_RUNTIME_PATH` now points to `/opt/codex-baked/bin/codex`. Existing tenant credentials and threads remain untouched. Existing `.state/codex-runtime/releases` are **not automatically deleted or modified**. If you deliberately manage a separate CLI, explicitly set `CWW_CODEX_RUNTIME_PATH=/opt/codex-runtime/current/bin/codex` and maintain that runtime yourself. Otherwise verify the bundled CLI is in use and stop containers referencing old releases before archiving or deleting only those old release directories. Never remove `.state/tenants` or Codex Home to reclaim duplicate binaries.
