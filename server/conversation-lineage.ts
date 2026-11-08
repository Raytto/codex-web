import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";

type Row = Record<string, string | number | null | { $storageBlob: string }>;
const wireRow = (row: Record<string, unknown>): Row => Object.fromEntries(Object.entries(row).map(([k,v]) => [k,v instanceof Uint8Array ? {$storageBlob:Buffer.from(v).toString("base64")} : v])) as Row;
const sqlValue = (value: Row[string]): SQLInputValue => value && typeof value === "object" ? Buffer.from(value.$storageBlob,"base64") : value;
export type ThreadIndexSnapshot = { tables: Record<string, Row[]>; originalPaths?: Record<string, string> };
export type LineageScope = { conversationId: string; userId: string; executorId: string; codexHome: string };
export type ThreadLineage = {
  version: 1;
  userId: string;
  executorId: string;
  codexHome: string;
  roots: string[];
  threads: Array<{ id: string; parentId: string | null; paths: string[] }>;
  index: ThreadIndexSnapshot;
};
type Rollout = { id: string; parentId: string | null; relativePath: string; size: number; allocated: number };
export type LineageInventory = {
  rollouts: Rollout[];
  rows: Row[];
  edges: Row[];
  related: Record<string, Row[]>;
  problems: Map<string, string[]>;
  unclassified: Array<{ relativePath: string; size: number; reason: string }>;
};
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const INDEX_TABLES = ["threads", "thread_dynamic_tools", "thread_attachments", "thread_read_receipts", "guardian_review_feedback", "thread_spawn_edges"];
const q = (value: string) => `"${value.replaceAll('"', '""')}"`;
export const hasTable = (db: DatabaseSync, table: string) => Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table));

/** Match only canonical members of this Home. The tenant mount alias is
 * scoped to the same account and executor; metadata, inode and graph checks
 * still establish ownership before an index row can be archived/restored. */
function indexPathKind(scope: Pick<LineageScope, "userId" | "executorId" | "codexHome">, indexed: unknown, relative: string): "native" | "tenant" | "legacy" | null {
  if (!/^(sessions|archived_sessions)\//.test(relative) || relative.split("/").some((part) => !part || part === "." || part === "..")) return null;
  if (indexed === `${scope.codexHome}/${relative}`) return "native";
  const tenantSuffix = `/tenants/${scope.userId}/codex-home`;
  if (UUID.test(scope.userId) && scope.executorId === "tenant-local" && scope.codexHome.endsWith(tenantSuffix)
    && indexed === `/app/tenants/${scope.userId}/codex-home/${relative}`) return "tenant";
  if (indexed === `/home/cww/.codex/${relative}`) return "legacy";
  return null;
}

export function parentFrom(source: unknown): string | null {
  if (typeof source === "string") { try { source = JSON.parse(source); } catch { return null; } }
  const parent = (source as { subagent?: { thread_spawn?: { parent_thread_id?: unknown } } })?.subagent?.thread_spawn?.parent_thread_id;
  if (parent === undefined) return null;
  if (typeof parent !== "string" || !UUID.test(parent)) throw new Error("invalid_parent_thread");
  return parent;
}

function firstMeta(file: string): { id: string; parentId: string | null } {
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const buffer = Buffer.alloc(1024 * 1024);
    const length = fs.readSync(fd, buffer, 0, buffer.length, 0);
    const line = buffer.subarray(0, length).toString("utf8").split("\n")[0];
    const item = JSON.parse(line) as { type?: string; payload?: { id?: string; source?: unknown } };
    if (item.type !== "session_meta" || !UUID.test(item.payload?.id ?? "")) throw new Error("invalid_session_meta");
    return { id: item.payload!.id!, parentId: parentFrom(item.payload?.source) };
  } finally { fs.closeSync(fd); }
}

export function readLineageInventory(home: string): LineageInventory {
  const inventory: LineageInventory = { rollouts: [], rows: [], edges: [], related: {}, problems: new Map(), unclassified: [] };
  const problem = (id: string, reason: string) => inventory.problems.set(id, [...(inventory.problems.get(id) ?? []), reason]);
  if (!fs.existsSync(home)) return inventory;
  if (fs.realpathSync(home) !== path.resolve(home)) throw new Error("codex_home_alias_unsupported");
  for (const folder of ["sessions", "archived_sessions"]) {
    const walk = (directory: string): void => {
      if (!fs.existsSync(directory)) return;
      if (fs.lstatSync(directory).isSymbolicLink()) throw new Error("rollout_directory_symlink");
      for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        const file = path.join(directory, entry.name);
        if (entry.isDirectory()) { walk(file); continue; }
        const relativePath = path.relative(home, file);
        const stat = fs.lstatSync(file);
        if (!entry.isFile()) throw new Error("rollout_not_regular");
        if (!entry.name.endsWith(".jsonl")) { inventory.unclassified.push({ relativePath, size: stat.size, reason: "unknown_session_material" }); continue; }
        try {
          const meta = firstMeta(file);
          inventory.rollouts.push({ ...meta, relativePath, size: stat.size, allocated: stat.blocks * 512 });
          if (stat.nlink !== 1) problem(meta.id, "rollout_shared_inode");
        } catch {
          inventory.unclassified.push({ relativePath, size: stat.size, reason: "invalid_session_meta" });
        }
      }
    };
    walk(path.join(home, folder));
  }
  const versions = fs.readdirSync(home).filter((name) => /^state_\d+\.sqlite$/.test(name));
  if (versions.some((name) => Number(name.match(/\d+/)![0]) > 5)) throw new Error("codex_index_version_unsupported");
  const file = path.join(home, "state_5.sqlite");
  if (fs.existsSync(file)) {
    const db = new DatabaseSync(file, { readOnly: true });
    try {
      db.exec("BEGIN");
      inventory.rows = db.prepare("SELECT * FROM threads ORDER BY id").all() as Row[];
      if (hasTable(db, "thread_spawn_edges")) inventory.edges = db.prepare("SELECT * FROM thread_spawn_edges ORDER BY child_thread_id").all() as Row[];
      for (const table of INDEX_TABLES.slice(1, -1)) if (hasTable(db, table)) inventory.related[table] = db.prepare(`SELECT * FROM ${q(table)} ORDER BY thread_id`).all().map(wireRow);
      if (hasTable(db,"thread_sections")) inventory.related.thread_sections = db.prepare("SELECT * FROM thread_sections ORDER BY id").all().map(wireRow);
      // An added per-thread table must be reviewed before its cascading rows
      // can be removed. Preserve rather than silently discard new materials.
      for (const { name } of db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>) {
        if (INDEX_TABLES.includes(name)) continue;
        const columns = db.prepare(`PRAGMA table_info(${q(name)})`).all() as Array<{ name: string }>;
        const foreignKeys = db.prepare(`PRAGMA foreign_key_list(${q(name)})`).all() as Array<{ table: string; from: string }>;
        const references = new Set(foreignKeys.filter((key) => key.table === "threads").map((key) => key.from));
        if (columns.some((col) => col.name === "thread_id")) references.add("thread_id");
        for (const column of references) for (const row of db.prepare(`SELECT DISTINCT ${q(column)} AS id FROM ${q(name)}`).all() as Array<{ id: string }>) problem(row.id, "unsupported_thread_index_material");
      }
    } finally { db.close(); }
  }
  return inventory;
}

/** Direct references remain in the Web DB. This reads historical segment and
 * recovery evidence without reinstating the retired rollover mechanism. */
export function conversationThreadReferences(db: DatabaseSync, userId: string, executorId: string): Map<string, Set<string>> {
  const refs = new Map<string, Set<string>>();
  const add = (conversationId: string, threadId: unknown) => {
    if (typeof threadId !== "string" || !UUID.test(threadId)) return;
    if (!refs.has(threadId)) refs.set(threadId, new Set());
    refs.get(threadId)!.add(conversationId);
  };
  const owners = db.prepare("SELECT c.id,c.codex_thread_id,s.manifest_json,s.manifest_sha256 FROM conversations c JOIN projects p ON p.id=c.project_id LEFT JOIN conversation_storage s ON s.conversation_id=c.id WHERE c.user_id=? AND p.executor_id=?")
    .all(userId, executorId) as Array<{ id: string; codex_thread_id: string | null; manifest_json: string | null; manifest_sha256: string | null }>;
  const ids = new Set(owners.map((row) => row.id));
  for (const row of owners) {
    add(row.id, row.codex_thread_id);
    if (row.manifest_json) {
      if (crypto.createHash("sha256").update(row.manifest_json).digest("hex") !== row.manifest_sha256) throw new Error("lineage_manifest_hash_mismatch");
      const manifest = JSON.parse(row.manifest_json) as { userId?: string; lineage?: ThreadLineage };
      if (manifest.userId === userId && manifest.lineage?.executorId === executorId) for (const thread of manifest.lineage.threads) add(row.id, thread.id);
    }
  }
  if (hasTable(db, "agent_engine_sessions")) {
    for (const row of db.prepare("SELECT conversation_id,native_id FROM agent_engine_sessions WHERE engine_id='codex' AND executor_id=?").all(executorId) as Array<{ conversation_id: string; native_id: string | null }>) if (ids.has(row.conversation_id)) add(row.conversation_id, row.native_id);
  }
  if (hasTable(db, "conversation_thread_segments")) {
    for (const row of db.prepare("SELECT conversation_id,codex_thread_id FROM conversation_thread_segments").all() as Array<{ conversation_id: string; codex_thread_id: string }>) if (ids.has(row.conversation_id)) add(row.conversation_id, row.codex_thread_id);
  }
  if (hasTable(db, "job_recovery_checkpoints")) {
    for (const row of db.prepare("SELECT j.conversation_id,cp.checkpoint_json FROM job_recovery_checkpoints cp JOIN jobs j ON j.id=cp.job_id").all() as Array<{ conversation_id: string; checkpoint_json: string }>) {
      if (ids.has(row.conversation_id)) add(row.conversation_id, (JSON.parse(row.checkpoint_json) as { threadId?: string }).threadId);
    }
  }
  for (const table of ["remote_thread_items", "remote_thread_events"]) if (hasTable(db, table)) {
    for (const row of db.prepare(`SELECT DISTINCT conversation_id,thread_id FROM ${table} WHERE executor_id=?`).all(executorId) as Array<{ conversation_id: string; thread_id: string }>) if (ids.has(row.conversation_id)) add(row.conversation_id, row.thread_id);
  }
  return refs;
}

export function collectConversationLineage(db: DatabaseSync, scope: LineageScope, archivedPaths: string[] = [], inventory = readLineageInventory(scope.codexHome), refs = conversationThreadReferences(db, scope.userId, scope.executorId)) {
  const roots = [...refs].filter(([, owners]) => owners.has(scope.conversationId)).map(([id]) => id).sort();
  const parents = new Map<string, Set<string>>();
  const children = new Map<string, Set<string>>();
  const addEdge = (child: string, parent: string | null) => {
    if (!parent) return;
    if (!parents.has(child)) parents.set(child, new Set());
    parents.get(child)!.add(parent);
    if (!children.has(parent)) children.set(parent, new Set());
    children.get(parent)!.add(child);
  };
  for (const row of inventory.edges) addEdge(String(row.child_thread_id), String(row.parent_thread_id));
  for (const row of inventory.rows) addEdge(String(row.id), parentFrom(row.source));
  for (const file of inventory.rollouts) addEdge(file.id, file.parentId);
  const ids = new Set<string>();
  const reasons = new Set<string>();
  const visiting = new Set<string>();
  const visit = (id: string) => {
    if (visiting.has(id)) { reasons.add("lineage_cycle"); return; }
    if (ids.has(id)) return;
    if (!UUID.test(id)) { reasons.add("lineage_invalid_thread"); return; }
    ids.add(id); visiting.add(id);
    for (const child of children.get(id) ?? []) visit(child);
    visiting.delete(id);
  };
  roots.forEach(visit);
  for (const id of ids) {
    if (parents.has(id) && inventory.rollouts.some((file) => file.id === id && !file.parentId)) reasons.add("lineage_parent_conflict");
    if ((parents.get(id)?.size ?? 0) > 1) reasons.add("lineage_parent_conflict");
    if ([...(parents.get(id) ?? [])].some((parent) => !ids.has(parent))) reasons.add("lineage_external_parent");
    if ([...(refs.get(id) ?? [])].some((owner) => owner !== scope.conversationId)) reasons.add("shared_codex_thread");
    for (const reason of inventory.problems.get(id) ?? []) reasons.add(reason);
  }
  const rollouts = inventory.rollouts.filter((file) => ids.has(file.id));
  const indexRows = inventory.rows.filter((row) => ids.has(String(row.id))).map((row) => ({ ...row }));
  for (const row of indexRows) {
    const files = rollouts.filter((file) => file.id === row.id);
    if (files.length > 1) reasons.add("lineage_duplicate_rollout");
    if (files.length) {
      const kind = indexPathKind(scope, row.rollout_path, files[0].relativePath);
      if (!kind) reasons.add("lineage_index_path_conflict");
      // Keep verified tenant execution paths: Codex resumes inside the container.
      // Historical shared-Home paths retain the existing host migration behavior.
      if (kind === "legacy") row.rollout_path = path.join(scope.codexHome, files[0].relativePath);
    }
    if (!files.length && !archivedPaths.some((relative) => indexPathKind(scope, row.rollout_path, relative))) reasons.add("lineage_rollout_missing");
  }
  for (const id of ids) {
    if (!indexRows.some((row) => row.id === id) && !rollouts.some((file) => file.id === id) && !roots.includes(id)) reasons.add("lineage_thread_missing");
  }
  // Unknown session files might be a damaged member. Fail closed for this
  // Home rather than assigning one by its filename.
  if (inventory.unclassified.length) reasons.add("unclassified_session_material");
  const tables: Record<string, Row[]> = { threads: indexRows, thread_spawn_edges: inventory.edges.filter((row) => ids.has(String(row.child_thread_id)) && ids.has(String(row.parent_thread_id))) };
  for (const [table, rows] of Object.entries(inventory.related)) tables[table] = rows.filter((row) => table === "thread_sections" ? indexRows.some(t => t.thread_section_id === row.id) : ids.has(String(row.thread_id)));
  const lineage: ThreadLineage = {
    version: 1, userId: scope.userId, executorId: scope.executorId, codexHome: path.resolve(scope.codexHome), roots,
    threads: [...ids].sort().map((id) => ({ id, parentId: [...(parents.get(id) ?? [])][0] ?? null, paths: rollouts.filter((file) => file.id === id).map((file) => file.relativePath).sort() })), index: { tables, originalPaths: Object.fromEntries(inventory.rows.filter((row) => ids.has(String(row.id))).map((row) => [String(row.id), String(row.rollout_path)])) },
  };
  const descendants = rollouts.filter((file) => parents.has(file.id));
  return { lineage, rollouts, reasons: [...reasons].sort(), rootRolloutBytes: rollouts.filter((file) => !parents.has(file.id)).reduce((sum, file) => sum + file.size, 0), childRolloutBytes: descendants.reduce((sum, file) => sum + file.size, 0), childRollouts: descendants.length };
}

export function mutateThreadIndex(home: string, snapshot: ThreadIndexSnapshot, operation: "restore" | "remove" | "check"): void {
  if (!(snapshot.tables.threads?.length)) return;
  const file = path.join(home, "state_5.sqlite");
  if (!fs.existsSync(file)) throw new Error("codex_index_missing");
  const db = new DatabaseSync(file);
  try {
    db.exec("PRAGMA foreign_keys=ON; PRAGMA busy_timeout=10000; BEGIN IMMEDIATE");
    const ids = snapshot.tables.threads.map((row) => String(row.id));
    if (operation === "remove" || operation === "check") {
      // A transaction checks the full row before removing any index entry.
      for (const row of snapshot.tables.threads) {
        const actual = db.prepare("SELECT * FROM threads WHERE id=?").get(String(row.id));
        if (actual && JSON.stringify(actual) !== JSON.stringify(row)) {
          // Legacy container path translation is the only tolerated delta.
          if (actual.rollout_path !== snapshot.originalPaths?.[String(row.id)]) throw new Error("codex_index_changed");
          const normalized = { ...actual, rollout_path: row.rollout_path };
          if (JSON.stringify(normalized) !== JSON.stringify(row)) throw new Error("codex_index_changed");
        }
      }
      for (const id of ids) {
        const present = Boolean(db.prepare("SELECT 1 FROM threads WHERE id=?").get(id));
        for (const table of INDEX_TABLES.slice(1, -1)) {
          const expected = present ? (snapshot.tables[table] ?? []).filter(row => row.thread_id === id) : [];
          if (!hasTable(db, table)) {
            if (expected.length) throw new Error("codex_index_schema_changed");
            continue;
          }
          const actual = db.prepare(`SELECT * FROM ${q(table)} WHERE thread_id=?`).all(id).map(wireRow);
          const canonical = (rows: Row[]) => JSON.stringify(rows.map(row => JSON.stringify(Object.entries(row).sort(([a], [b]) => a.localeCompare(b)))).sort());
          if (canonical(actual) !== canonical(expected)) throw new Error("codex_index_changed");
        }
        if(operation==='check')continue;
        if (hasTable(db, "thread_spawn_edges")) db.prepare("DELETE FROM thread_spawn_edges WHERE child_thread_id=? OR parent_thread_id=?").run(id, id);
        for (const table of INDEX_TABLES.slice(1, -1)) if (hasTable(db, table)) db.prepare(`DELETE FROM ${q(table)} WHERE thread_id=?`).run(id);
        db.prepare("DELETE FROM threads WHERE id=?").run(id);
      }
    } else {
      for (const table of ["thread_sections",...INDEX_TABLES]) {
        const rows = snapshot.tables[table] ?? [];
        if (!rows.length) continue;
        if (!hasTable(db, table)) throw new Error("codex_index_schema_changed");
        const columns = db.prepare(`PRAGMA table_info(${q(table)})`).all() as Array<{ name: string; pk: number }>;
        const primary = columns.filter((col) => col.pk).sort((a, b) => a.pk - b.pk).map((col) => col.name);
        for (const row of rows) {
          if (!Object.keys(row).every((key) => columns.some((col) => col.name === key))) throw new Error("codex_index_schema_changed");
          const where = primary.map((key) => `${q(key)}=?`).join(" AND ");
          const existing = db.prepare(`SELECT * FROM ${q(table)} WHERE ${where}`).get(...primary.map((key) => sqlValue(row[key]))) as Record<string,unknown> | undefined;
          if (existing) {
            if(table === "thread_sections")continue; // Shared section names can legitimately change independently.
            if (table === "threads" && existing.rollout_path !== row.rollout_path && existing.rollout_path === snapshot.originalPaths?.[String(row.id)]
              && Object.entries(row).every(([key, value]) => key === "rollout_path" || JSON.stringify(wireRow(existing)[key]) === JSON.stringify(value))) {
              db.prepare("UPDATE threads SET rollout_path=? WHERE id=?").run(sqlValue(row.rollout_path), sqlValue(row.id));
              existing.rollout_path = row.rollout_path;
            }
            if (!Object.entries(row).every(([key, value]) => JSON.stringify(wireRow(existing)[key]) === JSON.stringify(value))) throw new Error("codex_index_restore_conflict");
            continue;
          }
          const keys = Object.keys(row);
          db.prepare(`INSERT INTO ${q(table)} (${keys.map(q).join(",")}) VALUES (${keys.map(() => "?").join(",")})`).run(...keys.map((key) => sqlValue(row[key])));
        }
      }
    }
    db.exec("COMMIT");
  } catch (error) { try { db.exec("ROLLBACK"); } catch {} throw error; }
  finally { db.close(); }
}

export function validateRestoredLineage(home: string, lineage: ThreadLineage): void {
  if (lineage.version !== 1 || lineage.codexHome !== path.resolve(home)) throw new Error("lineage_scope_mismatch");
  const nodes = new Map(lineage.threads.map((thread) => [thread.id, thread]));
  if (nodes.size !== lineage.threads.length || lineage.roots.some((id) => !nodes.has(id))) throw new Error("lineage_manifest_invalid");
  for (const thread of nodes.values()) {
    if (!UUID.test(thread.id)) throw new Error("lineage_manifest_invalid");
    const seen = new Set<string>();
    for (let current: typeof thread | undefined = thread; current; current = current.parentId ? nodes.get(current.parentId) : undefined) {
      if (seen.has(current.id) || (current.parentId && !nodes.has(current.parentId))) throw new Error("lineage_manifest_invalid");
      seen.add(current.id);
    }
    for (const relative of thread.paths) {
      if (!/^(sessions|archived_sessions)\//.test(relative) || relative.split("/").some((part) => !part || part === "." || part === "..")) throw new Error("lineage_manifest_path_invalid");
      const meta = firstMeta(path.join(home, relative));
      if (meta.id !== thread.id || meta.parentId !== thread.parentId) throw new Error("lineage_manifest_meta_conflict");
    }
  }
  for (const [table, rows] of Object.entries(lineage.index.tables)) {
    if (!["thread_sections",...INDEX_TABLES].includes(table)) throw new Error("lineage_index_table_invalid");
    for (const row of rows) {
      if (table === "threads") {
        const node = nodes.get(String(row.id));
        if (!node?.paths.some((relative) => {
          const kind = indexPathKind(lineage, row.rollout_path, relative);
          return kind === "native" || kind === "tenant";
        })) throw new Error("lineage_index_path_conflict");
      } else if (table === "thread_sections") {
        if (!(lineage.index.tables.threads??[]).some(t=>t.thread_section_id===row.id)) throw new Error("lineage_section_scope_invalid");
      } else if (table === "thread_spawn_edges") {
        if (nodes.get(String(row.child_thread_id))?.parentId !== row.parent_thread_id) throw new Error("lineage_parent_conflict");
      } else if (!nodes.has(String(row.thread_id))) throw new Error("lineage_index_thread_invalid");
    }
  }
}
