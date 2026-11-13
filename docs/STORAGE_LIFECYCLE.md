# Optional storage lifecycle, backup and recovery

[配置总览](SETUP_GUIDE.zh-CN.md#7-存储备份与恢复) · [English setup](SETUP_GUIDE.en.md#storage-upgrade-and-acceptance)

This is an **opt-in host integration**, not a service enabled by base Compose. It keeps metadata local, encrypts immutable chunks, verifies remote bytes before isolation, and restores originals before use. Native Codex thread lineage, registered files, reader resources, voice, events and recovery dependencies have separate state. Unknown files are retained conservatively. No cloud identity, age key, backup data or production paths ship with it.

## 1. Prepare independent configuration

Use a separately installed host release with Node.js ≥22.13, compiled `dist-server`, production dependencies and `deploy/storage-*` helpers. Build it from the reviewed public commit; do not run the app with a private source checkout. Record its revision in `<host-release>/release-commit` using `git rev-parse HEAD`. The host may install optional dependencies; the base container remains small.

Install `age`, Python 3, `flock`/util-linux, GNU tar and the supported `aliyunpan` CLI. Obtain the tools from [age's project](https://github.com/FiloSottile/age) and [the CLI maintainer](https://github.com/tickstep/aliyunpan). The CLI is a third-party client, not an official cloud API credential service. Complete your own cloud-drive login; inspect its help/account output locally for your drive ID, config location and authorized directory. Never paste refresh tokens into a report.

Generate your own age identity with `age-keygen -o <private-identity-file>` and derive its recipient with `age-keygen -y <private-identity-file> > <recipient-file>`. Protect the identity with mode 0600 and retain an independent recovery copy. Existing installations must keep their existing identity and matching recipient; losing it can make encrypted objects unrecoverable. The cloud login token and age identity serve different purposes.

Copy `deploy/storage-lifecycle.env.example` to an instance-owned 0600 environment file outside Git. It starts disabled. Fill in every path/identity needed by the selected operations:

| Settings | Meaning and source |
| --- | --- |
| `STORAGE_INSTANCE_ID` | Your short stable installation identifier; letters/digits/hyphen/underscore |
| `STORAGE_STATE_ROOT`, `STORAGE_DATA_ROOT`, `STORAGE_TENANT_ROOT`, `STORAGE_DATABASE_PATH` | Actual host paths of this installation, including `codex-web.sqlite`; do not use container paths in a host process |
| `STORAGE_HOST_CODEX_HOME`, `STORAGE_HOST_USER_ID` | Explicit host administrator's Codex Home and the public reserved identity from your installation; ordinary tenants remain mapped to their own homes |
| `STORAGE_LIFECYCLE_ROOT`, `STORAGE_TRANSFER_ROOT` | Private catalogue/locks and bounded scratch directories with sufficient disk space |
| `STORAGE_ALIYUN_COMMAND`, `STORAGE_ALIYUN_CONFIG`, `STORAGE_DRIVE_ID` | Absolute CLI path, private CLI config path and your own drive ID |
| `STORAGE_REMOTE_ROOT` | A dedicated absolute directory on your drive, never `/`; no other installation shares it |
| `STORAGE_AGE_COMMAND`, `STORAGE_AGE_IDENTITY`, `STORAGE_AGE_RECIPIENT` | Executable and **file paths**, not key contents |
| `STORAGE_MAINTENANCE_GATE`, `STORAGE_MAINTENANCE_LOCK` | Your deployment/maintenance gate and lock; publisher and archive operations must agree |
| `STORAGE_BACKUP_PLAN`, `STORAGE_ENGINE_VERSION` | Private backup-plan JSON and selected engine version |
| `STORAGE_LEGACY_*` | Only when migrating an existing archive: original roots/isolation and cloud roots; leave unused roots empty |
| `STORAGE_SHARED_MEASURE_ROOTS` | Optional comma-separated extra roots to measure separately |
| `STORAGE_BUILD_CLEANER` | Optional operator-reviewed command; omit to avoid unrelated build cleanup |

Use an environment loader or `EnvironmentFile=` in your own host service. The maintenance CLI does not read the app's `.env` implicitly. The Web app only needs `STORAGE_LIFECYCLE_ENABLED=1`, the host bridge and `STORAGE_HOST_DATA_ROOT` mapping; keep cloud config and encryption identity on the host. Use the same declared state roots in bridge and storage processes. Do not put host secrets in browser configuration or the tenant filesystem.

## 2. Test before enabling a schedule

Take a consistent backup first. Use isolated copies, a dedicated cloud test directory and a private empty recovery destination. Set `STORAGE_LIFECYCLE_ENABLED=1` only in that test environment, then run from the installed host release:

```bash
node dist-server/server/storage-maintenance-cli.js inventory
node dist-server/server/storage-maintenance-cli.js measure
node dist-server/server/storage-maintenance-cli.js backfill
```

`inventory` creates metadata entries; it is not a read of the original contents and must not count as user activity. `backfill` is a bounded maintenance pass and can upload/isolate eligible data. Review its receipt and blocked reasons. The default batch is one item, 120 seconds and conservative mode. Active jobs, open files, conflicting paths and unknown native history prevent unsafe eviction.

For interactive reads, enable the host bridge using the same roots, open a known cold item in Codex Web, and verify the restored byte hash and ownership. Exercise cross-account rejection, interrupted download/retry, a real resumed native thread and browser restore progress. A `.pp-storage-index.json` file is an index, not the original file. Never recreate a missing original from the index.

When this passes, install your own service/timer for:

```bash
node dist-server/server/storage-maintenance-cli.js tick
node dist-server/server/storage-maintenance-cli.js monitor
```

`monitor` is a long-running access observer with `deploy/storage-access-monitor.py`; it must run with the host permissions needed to inspect usage. `tick` is a finite batch; a five-minute timer is a possible starting cadence, not an installed default. Use a single instance per installation and the shared maintenance gates. Set memory/CPU/time budgets on your service. Do not install another application's production timers.

## 3. Build a private backup plan

Create a mode-0600 JSON file at `STORAGE_BACKUP_PLAN`. A minimal shape is:

```json
{
  "format": "pp-storage-backup-plan-v1",
  "codeSha": "<your-reviewed-40-character-public-commit>",
  "keyRecovery": {"mode": "external", "reference": "<your-offline-key-recovery-location>"},
  "localRecoveryRoot": "/var/lib/codex-web-recovery",
  "extraSources": [],
  "excludeData": [],
  "excludeTenant": [],
  "excludeNative": []
}
```

Replace placeholders. `reference` describes where you keep an independent key copy; never place key contents there. Add explicit source/target entries for configuration, optional host service files or other required restore material. Symlinks require an explicit reviewed target and overlapping paths are rejected. The normal account data/native homes and registered metadata are collected by the engine; the encryption identity itself is excluded.

Run `storage-maintenance-cli.js backup` only after active runtimes have drained and your publisher/maintenance gate is held consistently. It uses bounded consistent SQLite snapshots, verified immutable chunks and a complete recovery manifest. It does not make a full staging tarball. `local-recovery` compacts the local point; it is not proof of a remote restore. `deploy/storage-publish-recovery-catalog.mjs` can publish encrypted recovery metadata and a portable helper after a verified backup. Its cloud receipt validates ciphertext and decrypted metadata; retain successful state to avoid rereading archived originals.

## 4. Restore into an empty destination

Keep the descriptor's path and your keys/config outside the failed installation. Supply the documented `STORAGE_*` identity/drive/root settings and run:

```bash
node dist-server/server/storage-recovery-cli.js \
  --descriptor /your-cloud-root/recovery/your-point.json \
  --destination /var/lib/codex-web-restore-test \
  --scratch /var/lib/codex-web-restore-scratch
```

Use your actual descriptor path. The destination must be an empty private directory; do not restore over live data. Validate file SHA-256 values, SQLite `integrity_check`, expected account/project counts, permissions and a separately started restored instance. Only then record an audited drill with `--record-drill-db <explicit-database-path>`. A CLI process exiting successfully or an upload existing alone is not a recovery proof.

For a portable single-file recovery without the app, see [the cloud recovery note](../deploy/STORAGE_CLOUD_RECOVERY.md) and `storage-recover-file.py --help`. The external helper does not need your original live database; it still needs your own authorization and encryption identity.

## 5. Disable and retain recovery

Stop the observer and archive/backup timers first. Setting `STORAGE_LIFECYCLE_ENABLED=0` stops new maintenance, but cold originals still require a working recovery path. Restore required objects before disabling the application's recovery integration. Keep verified remote objects, keys, descriptors and prior recovery points until their retention requirements and a real restore drill permit deletion. Do not run global Docker/cache pruning or delete another installation's archives.

Legacy conversation v1/v2 remains readable; v3 includes descendant/native lineage and file ownership. The new lifecycle engine is a distinct opt-in migration. It does not automatically upload a different engine's unmanaged account directory or assert complete third-party history coverage. When the old source is missing, retain an explicit unavailable boundary instead of inventing recovered contents.

## Object-only archival and local reclamation

Whole-site backup and object recovery are separate verification scopes. The catalogue publisher can publish verified object metadata without claiming a whole-site restore drill. Its successful descriptor readback records `descriptorProof` with the catalogue hash, descriptor identity and byte/hash evidence. If an older state has the same catalogue hash but lacks this proof, republish and verify the descriptor before treating that state as usable recovery evidence.

For an explicitly reviewed normal-mode service, set `STORAGE_MAINTENANCE_MODE=normal` in its own private host environment only after an independent object restore and key-recovery check. Retain the configured isolation grace plus version, reference, lease and active-process protections. This does not authorize deleting the cloud recovery chain, turning on whole-site backup/compaction or installing another instance's production timers. The public distribution keeps host scheduling opt-in; no private deployment installer or identity manifest is included.

仅启用对象归档与本地回收时，仍须先验证独立对象恢复、密钥保管、目录发布回读和descriptorProof。后台保持既定隔离期及所有保护；不因此开启整站大备份、数据库压缩或删除云端索引。
