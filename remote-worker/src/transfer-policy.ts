// Keep the server and standalone Worker limits aligned (covered by contract tests).
// Bound per-file HTTP/metadata overhead even for empty files. This does not limit local file creation.
export const REMOTE_TRANSFER_MAX_FILES_PER_JOB = 256;
export const REMOTE_TRANSFER_MAX_FILE_BYTES = 2 * 1024 * 1024 * 1024;
export const REMOTE_TRANSFER_MAX_TOTAL_BYTES_PER_JOB = 8 * 1024 * 1024 * 1024;
export const REMOTE_TRANSFER_TIMEOUT_MS = 30 * 60_000;
