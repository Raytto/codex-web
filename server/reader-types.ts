/** Shared reader-domain types.  A source is stable identity; every imported or
 * derived representation is an immutable version.  Keeping these two concepts
 * separate makes future OCR versions possible without changing annotations. */

export type ReaderFormat = "markdown" | "html" | "pdf" | "epub";
export type ReaderVersionKind = "original" | "normalized" | "ocr";
export type ReaderVersionStatus = "ready" | "processing" | "failed" | "cold" | "restoring";

export type ReaderCapability =
  | "vertical-flow"
  | "pagination"
  | "text-selection"
  | "highlight"
  | "note"
  | "agent-ask"
  | "range-fetch"
  | "nearby-prefetch";

export type ReadingSourceRow = {
  id: string;
  user_id: string;
  file_id: string;
  format: ReaderFormat;
  title: string;
  author: string | null;
  created_at: string;
  updated_at: string;
};

export type ReadingSourceVersionRow = {
  id: string;
  source_id: string;
  user_id: string;
  file_id: string;
  version_no: number;
  derived_kind: ReaderVersionKind;
  source_sha256: string | null;
  source_bytes: number;
  parser_version: string;
  status: ReaderVersionStatus;
  normalized_root: string | null;
  manifest_json: string | null;
  last_accessed_at: string;
  storage_state: "local" | "uploading" | "remote_verified" | "evicting" | "cold" | "restoring" | "error";
  storage_generation: number;
  storage_revision: number;
  storage_manifest_json: string | null;
  storage_manifest_sha256: string | null;
  storage_archive_sha256: string | null;
  storage_archive_bytes: number | null;
  storage_plaintext_bytes: number | null;
  remote_drive_id: string | null;
  remote_path: string | null;
  local_isolated_path: string | null;
  last_error: string | null;
  storage_uploaded_at: string | null;
  storage_verified_at: string | null;
  storage_restored_at: string | null;
  created_at: string;
  updated_at: string;
};

export type ReadingUnitRow = {
  id: string;
  version_id: string;
  ordinal: number;
  kind: "spine" | "page";
  href: string;
  title: string | null;
  media_type: string;
  content_path: string | null;
  byte_size: number;
  text_content: string | null;
  metadata_json: string | null;
  created_at: string;
};

export type ReadingProgressRow = {
  user_id: string;
  version_id: string;
  unit_id: string | null;
  position_json: string;
  updated_at: string;
};

export type ReadingAnnotationType = "highlight" | "note";
export type ReadingAnnotationRow = {
  id: string;
  user_id: string;
  version_id: string;
  unit_id: string | null;
  type: ReadingAnnotationType;
  quote_text: string;
  note_text: string | null;
  color: string;
  locator_json: string;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
};

export type ReaderManifest = {
  source: {
    id: string;
    fileId: string;
    title: string;
    author: string | null;
    format: ReaderFormat;
  };
  version: {
    id: string;
    versionNo: number;
    derivedKind: ReaderVersionKind;
    status: ReaderVersionStatus;
    parserVersion: string;
    sourceBytes: number;
    lastAccessedAt: string;
    error: string | null;
  };
  capabilities: ReaderCapability[];
  units: Array<Pick<ReadingUnitRow, "id" | "ordinal" | "kind" | "href" | "title" | "media_type" | "byte_size">>;
  endpoints: {
    bytes: string;
    manifest: string;
  };
};
