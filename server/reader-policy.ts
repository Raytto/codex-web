/**
 * Reader v1 policy ceilings.
 *
 * This module intentionally has no application/runtime dependencies.  The
 * root-owned host bridge imports reader cold-storage helpers from the server
 * bundle, so policy constants used by that path must not pull `config.ts`
 * (which loads dotenv and is only packaged inside the web container).
 */
export const READER_V1_MAX_FILE_BYTES = 100 * 1024 * 1024;
export const READER_V1_MAX_CONCURRENT_READS = 5;
export const READER_V1_MAX_RANGE_BYTES = 1 * 1024 * 1024;
export const READER_V1_RETENTION_DAYS = 15;
