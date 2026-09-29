import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import type { AppDatabase } from "./db.js";
import type {
  ParaBoard,
  ParaProject,
  ParaArea,
  ParaResource,
  ParaBrief,
  ParaDetail,
  ParaConversation,
  ParaSidebarBoard,
  ParaSidebarProject,
} from "./para-types.js";

export class ParaError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}
export const emptyBrief = (): ParaBrief => ({
  goal: "",
  success: "",
  constraints: "",
  decisions: "",
  questions: "",
  next: "",
});
const now = () => new Date().toISOString();
const id = () => crypto.randomUUID();
export class ParaStore {
  constructor(readonly db: AppDatabase) {}
  get sql() {
    return this.db.sqlite;
  }
  transaction<T>(fn: () => T): T {
    this.sql.exec("BEGIN IMMEDIATE");
    try {
      const result = fn();
      this.sql.exec("COMMIT");
      return result;
    } catch (e) {
      this.sql.exec("ROLLBACK");
      throw e;
    }
  }
  receipt<T>(user: string, key: string, operation: string): T | undefined {
    const old = this.sql
      .prepare(
        "SELECT operation,result FROM para_requests WHERE user_id=? AND key=?",
      )
      .get(user, key) as { operation: string; result: string } | undefined;
    if (!old) return undefined;
    if (old.operation !== operation)
      throw new ParaError(409, "这次请求的内容已经变化，请重新提交。");
    return JSON.parse(old.result) as T;
  }
  once<T>(user: string, key: string, operation: string, fn: () => T): T {
    return this.transaction(() => {
      const old = this.sql
        .prepare(
          "SELECT operation,result FROM para_requests WHERE user_id=? AND key=?",
        )
        .get(user, key) as { operation: string; result: string } | undefined;
      if (old) {
        if (old.operation !== operation)
          throw new ParaError(409, "这次请求的内容已经变化，请重新提交。");
        return JSON.parse(old.result) as T;
      }
      const result = fn();
      this.sql
        .prepare("INSERT INTO para_requests VALUES(?,?,?,?,?)")
        .run(user, key, operation, JSON.stringify(result), now());
      return result;
    });
  }
  board(user: string, boardId: string): ParaBoard {
    const b = this.sql
      .prepare("SELECT * FROM para_boards WHERE id=? AND user_id=?")
      .get(boardId, user) as ParaBoard | undefined;
    if (!b) throw new ParaError(404, "看板不存在。");
    return b;
  }
  project(user: string, projectId: string): ParaProject {
    const p = this.sql
      .prepare("SELECT * FROM para_projects WHERE id=? AND user_id=?")
      .get(projectId, user) as
      | (Omit<ParaProject, "brief"> & { brief: string })
      | undefined;
    if (!p) throw new ParaError(404, "项目不存在。");
    return { ...p, brief: { ...emptyBrief(), ...JSON.parse(p.brief) } };
  }
  resource(user: string, resourceId: string): ParaResource {
    const r = this.sql
      .prepare("SELECT * FROM para_resources WHERE id=? AND user_id=?")
      .get(resourceId, user) as ParaResource | undefined;
    if (!r) throw new ParaError(404, "资料不存在。");
    return r;
  }
  area(user: string, areaId: string): ParaArea {
    const r = this.sql
      .prepare("SELECT * FROM para_areas WHERE id=? AND user_id=?")
      .get(areaId, user) as ParaArea | undefined;
    if (!r) throw new ParaError(404, "领域不存在。");
    return r;
  }
  engine(user: string, engineId: string | null | undefined) {
    if (engineId && !this.db.getProjectForUser(engineId, user))
      throw new ParaError(404, "工作工程不存在或不可访问。");
  }
  revision(actual: number, expected: number) {
    if (actual !== expected)
      throw new ParaError(
        409,
        "其他窗口已更新此内容。你的输入仍保留，请重新加载最新版本后再合并保存。",
      );
  }
  boards(user: string): ParaBoard[] {
    return this.sql
      .prepare(
        "SELECT * FROM para_boards WHERE user_id=? ORDER BY position,created_at,id",
      )
      .all(user) as ParaBoard[];
  }
  sidebar(user: string, query: string, archived: boolean): ParaSidebarBoard[] {
    const match = `%${query.replace(/[\\%_]/g, "\\$&")}%`;
    return this.sql.prepare(`SELECT b.*,
      (SELECT count(*) FROM para_projects p WHERE p.user_id=b.user_id AND p.board_id=b.id
        AND (? OR p.archived_at IS NULL) AND (b.name LIKE ? ESCAPE '\\' OR p.title LIKE ? ESCAPE '\\')) AS project_count
      FROM para_boards b WHERE b.user_id=? AND (? OR b.archived_at IS NULL)
      AND (b.name LIKE ? ESCAPE '\\' OR EXISTS (SELECT 1 FROM para_projects p
        WHERE p.user_id=b.user_id AND p.board_id=b.id AND (? OR p.archived_at IS NULL) AND p.title LIKE ? ESCAPE '\\'))
      ORDER BY b.position,b.created_at,b.id`).all(Number(archived), match, match, user, Number(archived), match, Number(archived), match) as ParaSidebarBoard[];
  }
  sidebarProjects(user: string, boardId: string, query: string, archived: boolean, limit: number, offset: number) {
    const board = this.board(user, boardId);
    if (board.archived_at && !archived) return { projects: [], total: 0, nextOffset: offset, hasMore: false };
    const match = `%${query.replace(/[\\%_]/g, "\\$&")}%`;
    const where = `user_id=? AND board_id=? AND (? OR archived_at IS NULL) AND (? LIKE ? ESCAPE '\\' OR title LIKE ? ESCAPE '\\')`;
    const args = [user, boardId, Number(archived), board.name, match, match];
    const { total } = this.sql.prepare(`SELECT count(*) AS total FROM para_projects WHERE ${where}`).get(...args) as { total: number };
    const projects = this.sql.prepare(`SELECT id,board_id,title,stage,paused,revision,archived_at FROM para_projects
      WHERE ${where} ORDER BY sidebar_order DESC,id LIMIT ? OFFSET ?`).all(...args, limit, offset) as ParaSidebarProject[];
    return { projects, total, nextOffset: offset + projects.length, hasMore: offset + projects.length < total };
  }
  reorderSidebarProjects(user: string, sourceId: string, targetId: string, placement: "before" | "after") {
    return this.transaction(() => {
      const source = this.project(user, sourceId), target = this.project(user, targetId);
      if (source.board_id !== target.board_id) throw new ParaError(400, "请在同一个看板内调整项目顺序。");
      if (this.board(user, source.board_id).archived_at || source.archived_at || target.archived_at)
        throw new ParaError(409, "请先恢复看板和项目。");
      if (sourceId === targetId) return;
      const rows = this.sql.prepare("SELECT id FROM para_projects WHERE user_id=? AND board_id=? ORDER BY sidebar_order DESC,id")
        .all(user, source.board_id) as { id: string }[];
      const ordered = rows.filter((p) => p.id !== sourceId);
      ordered.splice(ordered.findIndex((p) => p.id === targetId) + (placement === "after" ? 1 : 0), 0, { id: sourceId });
      const update = this.sql.prepare("UPDATE para_projects SET sidebar_order=? WHERE id=? AND user_id=?");
      ordered.forEach((p, index) => update.run(ordered.length - index, p.id, user));
    });
  }
  createBoard(user: string, name: string, engine: string | null) {
    this.engine(user, engine);
    const boardId = id(),
      time = now();
    this.sql
      .prepare(
        "INSERT INTO para_boards(id,user_id,name,default_project_id,created_at,updated_at,position) VALUES(?,?,?,?,?,?,(SELECT COALESCE(MAX(position),-1)+1 FROM para_boards WHERE user_id=?))",
      )
      .run(boardId, user, name, engine, time, time, user);
    return this.board(user, boardId);
  }
  reorderBoards(user: string, sourceId: string, targetId: string, placement: "before" | "after") {
    return this.transaction(() => {
      this.board(user, sourceId);
      this.board(user, targetId);
      const boards = this.boards(user);
      if (sourceId === targetId) return boards;
      const source = boards.find((board) => board.id === sourceId)!;
      const ordered = boards.filter((board) => board.id !== sourceId);
      const at = ordered.findIndex((board) => board.id === targetId) + (placement === "after" ? 1 : 0);
      ordered.splice(at, 0, source);
      const update = this.sql.prepare("UPDATE para_boards SET position=?,revision=revision+1,updated_at=? WHERE id=? AND user_id=?");
      const time = now();
      ordered.forEach((board, index) => {
        if (board.position !== index) update.run(index, time, board.id, user);
      });
      return this.boards(user);
    });
  }
  updateBoard(
    user: string,
    boardId: string,
    patch: {
      revision: number;
      name?: string;
      default_project_id?: string | null;
      archived?: boolean;
    },
  ) {
    return this.transaction(() => {
      const b = this.board(user, boardId);
      this.revision(b.revision, patch.revision);
      this.engine(user, patch.default_project_id);
      this.sql
        .prepare(
          "UPDATE para_boards SET name=?,default_project_id=?,archived_at=?,revision=revision+1,updated_at=? WHERE id=?",
        )
        .run(
          patch.name ?? b.name,
          patch.default_project_id === undefined
            ? b.default_project_id
            : patch.default_project_id,
          patch.archived === undefined
            ? b.archived_at
            : patch.archived
              ? now()
              : null,
          now(),
          boardId,
        );
      return this.board(user, boardId);
    });
  }
  projects(user: string, boardId: string): ParaProject[] {
    this.board(user, boardId);
    const rows = this.sql
      .prepare(
        `SELECT p.*,
      (SELECT count(*) FROM para_resource_links r WHERE r.project_id=p.id) AS resource_count,
      (SELECT count(*) FROM para_conversations l JOIN conversations c ON c.id=l.conversation_id WHERE l.project_id=p.id AND c.deleted_at IS NULL) AS conversation_count,
      (SELECT COALESCE(sum(c.has_unread_result),0) FROM para_conversations l JOIN conversations c ON c.id=l.conversation_id WHERE l.project_id=p.id AND c.deleted_at IS NULL) AS unread_count,
      (SELECT count(*) FROM para_conversations l JOIN conversations c ON c.id=l.conversation_id WHERE l.project_id=p.id AND c.deleted_at IS NULL AND (c.status='running' OR c.external_status='running')) AS running_count
      FROM para_projects p WHERE p.user_id=? AND p.board_id=? ORDER BY p.position,p.created_at,p.id`,
      )
      .all(user, boardId) as (Omit<ParaProject, "brief"> & { brief: string })[];
    return rows.map((p) => ({
      ...p,
      brief: { ...emptyBrief(), ...JSON.parse(p.brief) },
    }));
  }
  event(user: string, projectId: string, action: string) {
    const p = this.project(user, projectId);
    this.sql
      .prepare(
        "INSERT INTO para_events(project_id,revision,action,snapshot,created_at) VALUES(?,?,?,?,?)",
      )
      .run(projectId, p.revision, action, JSON.stringify(p), now());
  }
  createProject(
    user: string,
    boardId: string,
    title: string,
    stage: ParaProject["stage"] = "idea",
  ) {
    const b = this.board(user, boardId);
    if (b.archived_at) throw new ParaError(409, "请先恢复看板。");
    const pid = id(),
      time = now();
    this.sql
      .prepare(
        "INSERT INTO para_projects(id,user_id,board_id,title,stage,brief,position,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)",
      )
      .run(
        pid,
        user,
        boardId,
        title,
        stage,
        JSON.stringify(emptyBrief()),
        Date.now(),
        time,
        time,
      );
    this.event(user, pid, "创建项目");
    return this.project(user, pid);
  }
  updateProject(
    user: string,
    projectId: string,
    patch: {
      revision: number;
      title?: string;
      stage?: ParaProject["stage"];
      paused?: boolean;
      area_id?: string | null;
      brief?: ParaBrief;
      default_project_id?: string | null;
      archived?: boolean;
      board_id?: string;
      position?: number;
      confirm_running?: boolean;
    },
  ) {
    return this.transaction(() => {
      const p = this.project(user, projectId);
      this.revision(p.revision, patch.revision);
      this.engine(user, patch.default_project_id);
      const boardId = patch.board_id ?? p.board_id;
      const board = this.board(user, boardId);
      if (board.archived_at && patch.archived !== false)
        throw new ParaError(409, "请先恢复看板。");
      const areaId =
        patch.area_id === undefined
          ? boardId === p.board_id
            ? p.area_id
            : null
          : patch.area_id;
      if (
        areaId &&
        (this.area(user, areaId).board_id !== boardId ||
          (this.area(user, areaId).archived_at && areaId !== p.area_id))
      )
        throw new ParaError(400, "请选择当前看板中的可用领域。");
      if (
        patch.archived &&
        !patch.confirm_running &&
        this.detail(user, projectId).conversations.some(
          (c) =>
            c.status === "running" ||
            c.external_status === "running" ||
            c.active_wake_count,
        )
      )
        throw new ParaError(
          409,
          "项目仍有运行会话或自动续跑。归档不会停止它们，请确认后归档。",
        );
      const archived =
        patch.archived === undefined
          ? p.archived_at
          : patch.archived
            ? now()
            : null;
      this.sql
        .prepare(
          "UPDATE para_projects SET title=?,stage=?,paused=?,area_id=?,brief=?,default_project_id=?,archived_at=?,board_id=?,position=?,revision=revision+1,updated_at=? WHERE id=?",
        )
        .run(
          patch.title ?? p.title,
          patch.stage ?? p.stage,
          patch.paused === undefined ? p.paused : Number(patch.paused),
          areaId,
          JSON.stringify(patch.brief ?? p.brief),
          patch.default_project_id === undefined
            ? p.default_project_id
            : patch.default_project_id,
          archived,
          boardId,
          patch.position ?? p.position,
          now(),
          projectId,
        );
      this.event(
        user,
        projectId,
        patch.stage
          ? "更改阶段"
          : patch.archived === true
            ? "归档项目"
            : patch.archived === false
              ? "恢复项目"
              : "更新项目",
      );
      return this.project(user, projectId);
    });
  }
  areas(user: string, boardId: string): ParaArea[] {
    this.board(user, boardId);
    return this.sql
      .prepare(
        "SELECT * FROM para_areas WHERE user_id=? AND board_id=? ORDER BY title,id",
      )
      .all(user, boardId) as ParaArea[];
  }
  createArea(user: string, boardId: string, title: string, body: string) {
    this.board(user, boardId);
    const aid = id();
    this.sql
      .prepare(
        "INSERT INTO para_areas(id,user_id,board_id,title,body,updated_at) VALUES(?,?,?,?,?,?)",
      )
      .run(aid, user, boardId, title, body, now());
    return this.area(user, aid);
  }
  updateArea(
    user: string,
    areaId: string,
    patch: {
      revision: number;
      title?: string;
      body?: string;
      archived?: boolean;
    },
  ) {
    return this.transaction(() => {
      const a = this.area(user, areaId);
      this.revision(a.revision, patch.revision);
      this.sql
        .prepare(
          "UPDATE para_areas SET title=?,body=?,archived_at=?,revision=revision+1,updated_at=? WHERE id=?",
        )
        .run(
          patch.title ?? a.title,
          patch.body ?? a.body,
          patch.archived === undefined
            ? a.archived_at
            : patch.archived
              ? now()
              : null,
          now(),
          areaId,
        );
      return this.area(user, areaId);
    });
  }
  resources(user: string, boardId: string): ParaResource[] {
    this.board(user, boardId);
    return this.sql
      .prepare(
        `SELECT DISTINCT r.* FROM para_resources r WHERE r.user_id=? AND (r.board_id=? OR EXISTS(SELECT 1 FROM para_resource_links l JOIN para_projects p ON p.id=l.project_id WHERE l.resource_id=r.id AND p.board_id=?)) ORDER BY r.updated_at DESC,r.id`,
      )
      .all(user, boardId, boardId) as ParaResource[];
  }
  insertResource(
    user: string,
    input: Omit<
      ParaResource,
      "revision" | "archived_at" | "created_at" | "updated_at" | "user_id"
    >,
    projectId?: string,
    isOutput = false,
  ) {
    this.board(user, input.board_id);
    if (
      input.area_id &&
      this.area(user, input.area_id).board_id !== input.board_id
    )
      throw new ParaError(400, "领域不属于当前看板。");
    if (projectId) this.project(user, projectId);
    const time = now();
    this.sql
      .prepare(
        `INSERT INTO para_resources(id,user_id,board_id,area_id,title,kind,body,url,file_name,mime_type,size,sha256,source_conversation_id,source_message_id,source_file_id,source_title,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        input.id,
        user,
        input.board_id,
        input.area_id,
        input.title,
        input.kind,
        input.body,
        input.url,
        input.file_name,
        input.mime_type,
        input.size,
        input.sha256,
        input.source_conversation_id,
        input.source_message_id,
        input.source_file_id,
        input.source_title,
        time,
        time,
      );
    if (projectId) this.linkResource(user, projectId, input.id, isOutput);
    return this.resource(user, input.id);
  }
  linkResource(
    user: string,
    projectId: string,
    resourceId: string,
    isOutput = false,
    pinned = false,
  ) {
    this.project(user, projectId);
    this.resource(user, resourceId);
    this.sql
      .prepare(
        "INSERT INTO para_resource_links(project_id,resource_id,is_output,pinned) VALUES(?,?,?,?) ON CONFLICT(project_id,resource_id) DO UPDATE SET is_output=excluded.is_output,pinned=excluded.pinned",
      )
      .run(projectId, resourceId, Number(isOutput), Number(pinned));
    this.event(user, projectId, "收录资料");
  }
  updateResource(
    user: string,
    rid: string,
    patch: {
      revision: number;
      title?: string;
      body?: string;
      url?: string;
      area_id?: string | null;
      archived?: boolean;
    },
  ) {
    return this.transaction(() => {
      const r = this.resource(user, rid);
      this.revision(r.revision, patch.revision);
      if (
        patch.area_id &&
        this.area(user, patch.area_id).board_id !== r.board_id
      )
        throw new ParaError(400, "领域不属于当前看板。");
      this.sql
        .prepare(
          "UPDATE para_resources SET title=?,body=?,url=?,area_id=?,archived_at=?,revision=revision+1,updated_at=? WHERE id=?",
        )
        .run(
          patch.title ?? r.title,
          patch.body ?? r.body,
          patch.url ?? r.url,
          patch.area_id === undefined ? r.area_id : patch.area_id,
          patch.archived === undefined
            ? r.archived_at
            : patch.archived
              ? now()
              : null,
          now(),
          rid,
        );
      return this.resource(user, rid);
    });
  }
  linkConversation(
    user: string,
    projectId: string,
    conversationId: string,
    primary?: boolean,
  ) {
    this.project(user, projectId);
    const c = this.db.getConversationForUser(conversationId, user);
    if (!c) throw new ParaError(404, "会话不存在。");
    const existing = this.sql
      .prepare(
        "SELECT project_id FROM para_conversations WHERE conversation_id=? AND relation='primary'",
      )
      .get(conversationId) as { project_id: string } | undefined;
    if (primary && existing && existing.project_id !== projectId) {
      this.sql
        .prepare(
          "UPDATE para_conversations SET relation='reference' WHERE conversation_id=? AND relation='primary'",
        )
        .run(conversationId);
      this.event(user, existing.project_id, "主工作项目已更换");
    }
    const relation =
      primary === false
        ? "reference"
        : primary || !existing || existing.project_id === projectId
          ? "primary"
          : "reference";
    this.sql
      .prepare(
        "INSERT INTO para_conversations VALUES(?,?,?,?) ON CONFLICT(project_id,conversation_id) DO UPDATE SET relation=excluded.relation",
      )
      .run(projectId, conversationId, relation, now());
    this.event(
      user,
      projectId,
      relation === "primary" ? "关联工作会话" : "关联参考会话",
    );
    return relation;
  }
  conversationLinks(user: string, conversationId: string) {
    if (!this.db.getConversationForUser(conversationId, user))
      throw new ParaError(404, "会话不存在。");
    return this.sql
      .prepare(
        "SELECT p.id,p.board_id,p.title,p.revision,l.relation FROM para_conversations l JOIN para_projects p ON p.id=l.project_id WHERE l.conversation_id=? AND p.user_id=?",
      )
      .all(conversationId, user);
  }
  searchConversations(user: string, query: string, engine: string) {
    const rows = this.sql
      .prepare(
        `SELECT c.id,c.title,c.project_id,p.name AS project_name,p.executor_id,c.status,c.external_status,c.has_unread_result,c.updated_at,
      (SELECT pp.title FROM para_conversations pc JOIN para_projects pp ON pp.id=pc.project_id WHERE pc.conversation_id=c.id AND pc.relation='primary') AS main_title
      FROM conversations c LEFT JOIN projects p ON p.id=c.project_id WHERE c.user_id=? AND c.deleted_at IS NULL AND c.title LIKE ? ESCAPE '\\' AND (?='' OR c.project_id=?) ORDER BY c.updated_at DESC LIMIT 80`,
      )
      .all(user, `%${query.replace(/[\\%_]/g, "\\$&")}%`, engine, engine);
    return rows;
  }
  detail(user: string, projectId: string): ParaDetail {
    const project = this.project(user, projectId);
    const resources = this.sql
      .prepare(
        "SELECT r.*,l.is_output,l.pinned FROM para_resource_links l JOIN para_resources r ON r.id=l.resource_id WHERE l.project_id=? AND r.user_id=? ORDER BY l.pinned DESC,r.updated_at DESC",
      )
      .all(projectId, user) as ParaResource[];
    const rows = this.sql
      .prepare(
        `SELECT c.id,c.title,c.project_id,p.name AS project_name,p.executor_id,l.relation FROM para_conversations l JOIN conversations c ON c.id=l.conversation_id LEFT JOIN projects p ON p.id=c.project_id WHERE l.project_id=? AND c.user_id=? AND c.deleted_at IS NULL ORDER BY c.updated_at DESC`,
      )
      .all(projectId, user) as ParaConversation[];
    const conversations = rows.map((row) => {
      const c = this.db.getConversationForUser(row.id, user)!;
      return {
        ...row,
        status: c.status,
        external_status: c.external_status,
        has_unread_result: c.has_unread_result,
        active_wake_count: c.active_wake_count,
        cold_storage_state: c.cold_storage_state,
        updated_at: c.updated_at,
      };
    });
    return {
      project,
      resources,
      conversations,
      events: this.sql
        .prepare(
          "SELECT id,action,revision,created_at FROM para_events WHERE project_id=? ORDER BY id DESC LIMIT 50",
        )
        .all(projectId) as ParaDetail["events"],
    };
  }
}

export function resourcePath(
  tenantRoot: string,
  user: string,
  resourceId: string,
): string {
  if (!/^[a-f0-9-]{36}$/.test(user) || !/^[a-f0-9-]{36}$/.test(resourceId))
    throw new ParaError(400, "无效的资料标识。");
  const account = path.join(tenantRoot, user);
  if (
    fs.existsSync(account) &&
    fs.realpathSync(account) !== path.resolve(account)
  )
    throw new ParaError(409, "资料目录状态异常。");
  const root = path.join(account, "para-resources");
  if (
    fs.existsSync(root) &&
    (fs.lstatSync(root).isSymbolicLink() ||
      fs.realpathSync(root) !== path.resolve(root))
  )
    throw new ParaError(409, "资料目录状态异常。");
  const directory = path.join(root, resourceId);
  if (fs.existsSync(directory) && fs.lstatSync(directory).isSymbolicLink())
    throw new ParaError(409, "资料目录状态异常。");
  return path.join(directory, "content");
}
export function readResourceFile(tenantRoot: string, r: ParaResource): string {
  const file = resourcePath(tenantRoot, r.user_id, r.id);
  if (!fs.existsSync(file))
    throw new ParaError(409, "资料文件暂不可用，请重试或重新收录。");
  if (
    fs.realpathSync(file) !== path.resolve(file) ||
    !fs.statSync(file).isFile()
  )
    throw new ParaError(409, "资料文件状态异常。");
  return file;
}
