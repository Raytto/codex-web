# Contributing

Issues and pull requests are welcome. Keep changes focused, add or update tests for behavior changes, and run the application tests below before opening a pull request.

Never include credentials, personal server paths, production logs, database snapshots, Codex authentication data, or user files. By contributing, you agree that your contribution is licensed under the MIT License.

## Storage regression prerequisites

Linux development/test environments need `acl`, `age` (including `age-keygen`), `ffmpeg`, Python 3 and GNU tar. On Debian/Ubuntu: `sudo apt-get install acl age ffmpeg python3`. The tests create temporary keys and synthetic local cloud directories; they require no cloud account. Run `npm run test:storage-tools` for the portable recovery helpers. The complete application suite needs the permissions described below. Docker installs these tools only in its test stage; the default runtime does not enable cloud archival.

The complete application suite exercises host maintenance: it inspects `/proc` to reject unknown file writers and switches to separate tenant UIDs for permission tests. Run it in a disposable Linux test VM or the Docker test stage, with no production state or credentials. In a test VM, after `npm ci`, use:

```bash
sudo env "PATH=$PATH" npm test
npm --prefix remote-worker ci
npm run test:worker
npm run test:storage-tools
```

The public CI grants these permissions only to the application test process on its disposable runner. An ordinary user's `npm test` can fail with `EACCES` while inspecting `/proc`; do not bypass that storage safety check. `npm run lint`, `npm run build`, and the development server do not need root. For an immutable committed-source Docker test/build, use `CODEX_WEB_VERIFY_BUILD=1 ./scripts/build-image.sh` with Docker access. Fanotify tests explicitly report a skip if the test environment lacks `CAP_SYS_ADMIN`; a skip does not validate that kernel integration. The deployed Web process and tenant executors retain their separate low-privilege UIDs.
