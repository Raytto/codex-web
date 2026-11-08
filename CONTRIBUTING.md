# Contributing

Issues and pull requests are welcome. Keep changes focused, add or update tests for behavior changes, and run `npm test` before opening a pull request.

Never include credentials, personal server paths, production logs, database snapshots, Codex authentication data, or user files. By contributing, you agree that your contribution is licensed under the MIT License.

## Storage regression prerequisites

Linux development/test environments need `acl`, `age` (including `age-keygen`), Python 3 and GNU tar. On Debian/Ubuntu: `sudo apt-get install acl age python3`. The tests create temporary keys and synthetic local cloud directories; they require no cloud account. Run `npm run test:storage-tools` for the portable recovery helpers, or `npm run verify` after installing both app and Worker dependencies. Docker installs these tools only in its test stage; the default runtime does not enable cloud archival.
