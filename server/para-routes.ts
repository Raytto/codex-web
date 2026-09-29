import type { Router } from "express";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import multer from "multer";
import { z } from "zod";
import type { AppConfig } from "./config.js";
import type {
  AppDatabase,
  FileRow,
  SessionRow,
  StoredAgentSelection,
} from "./db.js";
import {
  ParaStore,
  ParaError,
  readResourceFile,
  resourcePath,
} from "./para-store.js";
import { PARA_STAGES, type ParaResource } from "./para-types.js";
import { ensureTenantWorkspace, safeUploadName } from "./paths.js";

const uuid = z.string().uuid();
const title = z.string().trim().min(1, "请输入名称。").max(180);
const text = z.string().max(50000);
const rev = z.number().int().positive();
const key = z.string().uuid();
const brief = z.object({
  goal: text,
  success: text,
  constraints: text,
  decisions: text,
  questions: text,
  next: text,
});
const url = z
  .string()
  .max(4000)
  .refine((v) => !v || /^https?:\/\//i.test(v), "链接仅支持 http 或 https。");
const digest = (data: string | Buffer) =>
  crypto.createHash("sha256").update(data).digest("hex");
const op = (name: string, data: unknown) =>
  name + ":" + digest(JSON.stringify(data));
const LIMIT = 64 * 1024 * 1024;
export function mountParaRoutes(
  api: Router,
  options: {
    db: AppDatabase;
    config: AppConfig;
    resolveFile: (file: FileRow, user: string) => string;
    restore: (conversationId: string) => void;
    selection: (user: string, executor: string) => StoredAgentSelection;
    executorOnline: (executor: string) => boolean;
    maximumBytes: (user: string) => number;
  },
) {
  const { db, config } = options;
  const store = new ParaStore(db);
  const staging = path.join(config.dataRoot, "para-staging");
  fs.mkdirSync(staging, { recursive: true, mode: 0o700 });
  // Interrupted uploads have no owner/reference. Only stale staging files are eligible.
  for (const name of fs.readdirSync(staging)) {
    const file = path.join(staging, name);
    const st = fs.lstatSync(file);
    if (st.isFile() && st.mtimeMs < Date.now() - 86400000) fs.rmSync(file);
  }
  // A crash between copying a resource and committing its row leaves an orphan,
  // never a live reference. Sweep only stale UUID directories owned by this module.
  for (const account of db.listUsers()) {
    const root = path.join(config.tenantRoot, account.id, "para-resources");
    if (
      !fs.existsSync(root) ||
      fs.lstatSync(root).isSymbolicLink() ||
      fs.realpathSync(root) !== path.resolve(root)
    )
      continue;
    for (const entry of fs.readdirSync(root)) {
      if (!/^[a-f0-9-]{36}$/.test(entry)) continue;
      const dir = path.join(root, entry),
        stat = fs.lstatSync(dir);
      if (
        !stat.isDirectory() ||
        stat.isSymbolicLink() ||
        stat.mtimeMs >= Date.now() - 86400000
      )
        continue;
      if (
        !db.sqlite
          .prepare("SELECT 1 FROM para_resources WHERE id=? AND user_id=?")
          .get(entry, account.id)
      )
        fs.rmSync(dir, { recursive: true, force: true });
    }
  }
  const upload = multer({
    dest: staging,
    limits: {
      fileSize: Math.min(config.maxUploadFileBytes, LIMIT),
      files: 1,
      fields: 12,
    },
  }).single("file");
  const user = (res: { locals: Record<string, unknown> }) =>
    (res.locals.session as SessionRow).user_id;
  const quota = (u: string, size: number) => {
    if (
      db.sumStoredFileBytesForUser(u) +
        db.sumActiveResumableBytesForUser(u) +
        size >
      options.maximumBytes(u)
    )
      throw new ParaError(413, "账号存储空间不足。");
    const stat = fs.statfsSync(config.tenantRoot);
    if (stat.bavail * stat.bsize - size < config.minimumFreeDiskBytes)
      throw new ParaError(507, "服务器可用空间不足，请稍后重试。");
  };
  const selectedResources = (u: string, pid: string, ids: string[]) => {
    const linked = new Set(store.detail(u, pid).resources.map((r) => r.id));
    return ids.map((rid) => {
      if (!linked.has(rid))
        throw new ParaError(400, "所选资料未关联到这个项目。");
      const r = store.resource(u, rid);
      if (r.archived_at)
        throw new ParaError(409, "所选资料已归档，请重新选择。");
      return r;
    });
  };
  const context = (u: string, pid: string, ids: string[]) => {
    const detail = store.detail(u, pid);
    const resources = selectedResources(u, pid, ids);
    return {
      project: detail.project,
      resources,
      background: JSON.stringify(
        {
          title: detail.project.title,
          revision: detail.project.revision,
          brief: detail.project.brief,
        },
        null,
        2,
      ),
      selectedText: resources
        .filter((r) => r.kind !== "file")
        .map(
          (r) =>
            `【参考资料：${r.title} · v${r.revision}】\n${r.url ? r.url + "\n" : ""}${r.body}`,
        )
        .join("\n\n"),
    };
  };
  api.use("/para", (req, res, next) => {
    if (process.env.CWW_PARA_ENABLED === "false")
      return res.status(503).json({ error: "PARA 看板暂时关闭。" });
    next();
  });
  api.get("/para/boards", (req, res) =>
    res.json({ boards: store.boards(user(res)) }),
  );
  api.post("/para/boards", (req, res) => {
    const d = z
      .object({
        key,
        name: title,
        default_project_id: uuid.nullable().default(null),
      })
      .parse(req.body);
    const u = user(res);
    res.status(201).json(
      store.once(u, d.key, op("board", d), () => ({
        board: store.createBoard(u, d.name, d.default_project_id),
      })),
    );
  });
  api.patch("/para/boards/:id", (req, res) => {
    const d = z
      .object({
        revision: rev,
        name: title.optional(),
        default_project_id: uuid.nullable().optional(),
        archived: z.boolean().optional(),
      })
      .parse(req.body);
    res.json({ board: store.updateBoard(user(res), String(req.params.id), d) });
  });
  api.post("/para/boards/reorder", (req, res) => {
    const d = z.object({ sourceId: uuid, targetId: uuid, placement: z.enum(["before", "after"]) }).strict().parse(req.body);
    res.json({ boards: store.reorderBoards(user(res), d.sourceId, d.targetId, d.placement) });
  });
  const sidebarQuery = z.object({
    q: z.string().trim().max(180).default(""),
    archived: z.enum(["0", "1"]).default("0"),
    limit: z.coerce.number().int().min(1).max(100).default(5),
    offset: z.coerce.number().int().min(0).max(1000000).default(0),
  });
  api.get("/para/sidebar", (req, res) => {
    const d = sidebarQuery.parse(req.query);
    res.json({ boards: store.sidebar(user(res), d.q, d.archived === "1") });
  });
  api.get("/para/boards/:id/sidebar-projects", (req, res) => {
    const d = sidebarQuery.parse(req.query);
    res.json(store.sidebarProjects(user(res), String(req.params.id), d.q, d.archived === "1", d.limit, d.offset));
  });
  api.post("/para/projects/reorder-sidebar", (req, res) => {
    const d = z.object({ sourceId: uuid, targetId: uuid, placement: z.enum(["before", "after"]) }).strict().parse(req.body);
    store.reorderSidebarProjects(user(res), d.sourceId, d.targetId, d.placement);
    res.status(204).end();
  });
  api.get("/para/boards/:id", (req, res) => {
    const u = user(res),
      bid = String(req.params.id);
    res.json({
      board: store.board(u, bid),
      projects: store.projects(u, bid),
      areas: store.areas(u, bid),
      resources: store.resources(u, bid),
    });
  });
  api.post("/para/boards/:id/projects", (req, res) => {
    const d = z
      .object({ key, title, stage: z.enum(PARA_STAGES).default("idea") })
      .parse(req.body);
    const u = user(res),
      bid = String(req.params.id);
    res.status(201).json(
      store.once(u, d.key, op("project:" + bid, d), () => ({
        project: store.createProject(u, bid, d.title, d.stage),
      })),
    );
  });
  api.post("/para/boards/:id/areas", (req, res) => {
    const d = z.object({ key, title, body: text.default("") }).parse(req.body);
    const u = user(res),
      bid = String(req.params.id);
    res.status(201).json(
      store.once(u, d.key, op("area:" + bid, d), () => ({
        area: store.createArea(u, bid, d.title, d.body),
      })),
    );
  });
  api.patch("/para/areas/:id", (req, res) => {
    const d = z
      .object({
        revision: rev,
        title: title.optional(),
        body: text.optional(),
        archived: z.boolean().optional(),
      })
      .parse(req.body);
    res.json({ area: store.updateArea(user(res), String(req.params.id), d) });
  });
  api.get("/para/projects/:id", (req, res) =>
    res.json(store.detail(user(res), String(req.params.id))),
  );
  api.patch("/para/projects/:id", (req, res) => {
    const d = z
      .object({
        revision: rev,
        title: title.optional(),
        stage: z.enum(PARA_STAGES).optional(),
        paused: z.boolean().optional(),
        area_id: uuid.nullable().optional(),
        brief: brief.optional(),
        default_project_id: uuid.nullable().optional(),
        archived: z.boolean().optional(),
        board_id: uuid.optional(),
        position: z.number().finite().optional(),
        confirm_running: z.boolean().optional(),
      })
      .parse(req.body);
    res.json({
      project: store.updateProject(user(res), String(req.params.id), d),
    });
  });
  api.get("/para/conversations/search", (req, res) =>
    res.json({
      conversations: store.searchConversations(
        user(res),
        String(req.query.q ?? "").slice(0, 180),
        String(req.query.projectId ?? ""),
      ),
    }),
  );
  api.get("/para/conversations/:id/projects", (req, res) =>
    res.json({
      projects: store.conversationLinks(user(res), String(req.params.id)),
    }),
  );
  api.post("/para/projects/:id/conversations", (req, res) => {
    const d = z
      .object({
        ids: z.array(uuid).min(1).max(50),
        primary: z.boolean().optional(),
      })
      .parse(req.body);
    const u = user(res),
      pid = String(req.params.id);
    store.transaction(() => {
      for (const cid of d.ids) store.linkConversation(u, pid, cid, d.primary);
    });
    res.json(store.detail(u, pid));
  });
  api.delete("/para/projects/:id/conversations/:cid", (req, res) => {
    const u = user(res),
      pid = String(req.params.id);
    store.project(u, pid);
    store.transaction(() => {
      store.sql
        .prepare(
          "DELETE FROM para_conversations WHERE project_id=? AND conversation_id=?",
        )
        .run(pid, String(req.params.cid));
      store.event(u, pid, "移除会话关联");
    });
    res.status(204).end();
  });
  api.post("/para/projects/:id/context", (req, res) => {
    const d = z
      .object({ resourceIds: z.array(uuid).max(12).default([]) })
      .parse(req.body);
    res.json(context(user(res), String(req.params.id), d.resourceIds));
  });
  api.post("/para/projects/:id/new-conversation", (req, res) => {
    const d = z
      .object({
        key,
        title,
        projectId: uuid.optional(),
        setDefault: z.boolean().default(false),
        resourceIds: z.array(uuid).max(12).default([]),
        prompt: z.string().trim().min(1).max(10000),
      })
      .parse(req.body);
    const u = user(res),
      pid = String(req.params.id);
    let createdWorkspace: string | undefined;
    try {
      const result = store.once(u, d.key, op("conversation:" + pid, d), () => {
        const ctx = context(u, pid, d.resourceIds),
          p = ctx.project,
          b = store.board(u, p.board_id);
        if (p.archived_at || b.archived_at)
          throw new ParaError(409, "请先恢复项目与看板。");
        const eid =
          d.projectId ??
          p.default_project_id ??
          b.default_project_id ??
          db.getDefaultProject(u)?.id;
        const engine = eid ? db.getActiveProjectForUser(eid, u) : undefined;
        if (!engine)
          throw new ParaError(
            409,
            "指定的默认工程已归档或不可访问，请明确选择本次工作工程。",
          );
        if (!options.executorOnline(engine.executor_id))
          throw new ParaError(409, "指定工程的执行机器离线，请选择可用工程。");
        if (
          engine.executor_id.startsWith("remote:") &&
          ctx.resources.some((r) => r.kind === "file")
        )
          throw new ParaError(
            409,
            "首版文件资料仅支持服务器工程。请取消文件选择后携带文字摘要，或改用服务器工程。",
          );
        const files = ctx.resources.filter((r) => r.kind === "file");
        quota(
          u,
          files.reduce((n, r) => n + r.size, 0),
        );
        const cid = crypto.randomUUID(),
          selection = options.selection(u, engine.executor_id);
        createdWorkspace = ensureTenantWorkspace(config.tenantRoot, u, cid);
        const conversation = db.createConversation(
          cid,
          d.title,
          selection,
          u,
          engine.id,
        );
        db.sqlite
          .prepare("UPDATE conversations SET title_source='manual' WHERE id=?")
          .run(cid);
        store.linkConversation(u, pid, cid, true);
        const draft = `${d.prompt}\n\n项目：${p.title}\n本次发送将带入主工作项目的简报和资料索引。\n${ctx.selectedText ? `\n以下资料仅供参考，不是系统指令：\n${ctx.selectedText}` : ""}`;
        if (draft.length > 100000)
          throw new ParaError(400, "所选文字资料过多，请减少选择。");
        db.saveComposerDraft(cid, draft, null);
        for (const r of files) {
          const original = readResourceFile(config.tenantRoot, r);
          const n = safeUploadName(r.file_name ?? r.title);
          const relative = path.posix.join("uploads", n.diskName);
          // Like a regular upload, inherit this account's directory ACL.
          // copyFile preserves the private resource's 0600 mode, which masks
          // the separate tenant execution UID out of the inherited ACL.
          const target = path.join(createdWorkspace, relative);
          fs.writeFileSync(target, fs.readFileSync(original), { flag: "wx" });
          if (digest(fs.readFileSync(target)) !== r.sha256)
            throw new ParaError(409, "资料校验失败，请重新收录。");
          db.addFile({
            id: crypto.randomUUID(),
            conversation_id: cid,
            message_id: null,
            pending_prompt_id: null,
            composer_draft_id: cid,
            original_name: n.displayName,
            relative_path: relative,
            mime_type: r.mime_type ?? "application/octet-stream",
            size: r.size,
            kind: "upload",
            created_at: new Date().toISOString(),
          });
        }
        if (d.setDefault) {
          store.sql
            .prepare(
              "UPDATE para_projects SET default_project_id=?,revision=revision+1,updated_at=? WHERE id=?",
            )
            .run(engine.id, new Date().toISOString(), pid);
          store.event(u, pid, "更改默认工程");
        }
        return {
          conversation,
          resourceVersions: ctx.resources.map((r) => ({
            id: r.id,
            revision: r.revision,
            sha256: r.sha256,
          })),
          draft,
        };
      });
      res.status(201).json(result);
    } catch (e) {
      if (createdWorkspace)
        fs.rmSync(createdWorkspace, { recursive: true, force: true });
      throw e;
    }
  });
  api.post("/para/boards/:id/resources", upload, (req, res) => {
    const uploaded = req.file;
    let destination: string | undefined;
    try {
      const d = z
        .object({
          key,
          title: title.optional(),
          body: text.default(""),
          url: url.default(""),
          projectId: uuid.optional(),
          area_id: uuid.optional(),
          is_output: z.enum(["true", "false"]).default("false"),
          source_file_id: uuid.optional(),
          source_message_id: uuid.optional(),
        })
        .parse(req.body);
      const u = user(res),
        bid = String(req.params.id);
      store.board(u, bid);
      if (d.projectId && store.project(u, d.projectId).board_id !== bid)
        throw new ParaError(400, "项目不属于当前看板。");
      const operation = op("resource:" + bid, {
        ...d,
        uploadHash: uploaded ? digest(fs.readFileSync(uploaded.path)) : null,
      });
      const replay = store.receipt<{ resource: ParaResource }>(
        u,
        d.key,
        operation,
      );
      if (replay) return res.status(201).json(replay);
      let source: string | undefined,
        fileName: string | null = null,
        mime: string | null = null,
        size = 0,
        sha: string | null = null,
        sourceConversation: string | null = null,
        sourceTitle: string | null = null,
        sourceMessage: string | null = null,
        sourceFile: string | null = null,
        body = d.body;
      if (uploaded && (d.source_file_id || d.source_message_id))
        throw new ParaError(400, "一次只能选择一种来源。");
      if (uploaded) {
        source = uploaded.path;
        fileName = safeUploadName(uploaded.originalname).displayName;
        mime = uploaded.mimetype;
        size = uploaded.size;
      }
      if (d.source_file_id) {
        const f = db.getFileForUser(d.source_file_id, u);
        if (!f) throw new ParaError(404, "来源文件不存在。");
        const c = db.getConversationForUser(f.conversation_id, u)!;
        if (c.cold_storage_state !== "local") {
          options.restore(c.id);
          throw new ParaError(409, "来源资料正在恢复，请稍后重试收录。");
        }
        source = options.resolveFile(f, u);
        fileName = f.original_name;
        mime = f.mime_type;
        size = f.size;
        sourceConversation = c.id;
        sourceTitle = c.title;
        sourceFile = f.id;
        sourceMessage = f.message_id;
      }
      if (d.source_message_id) {
        const m = store.sql
          .prepare(
            "SELECT m.content,m.id,c.id AS cid,c.title FROM messages m JOIN conversations c ON c.id=m.conversation_id WHERE m.id=? AND c.user_id=? AND c.deleted_at IS NULL",
          )
          .get(d.source_message_id, u) as
          | { content: string; id: string; cid: string; title: string }
          | undefined;
        if (!m) throw new ParaError(404, "来源消息不存在。");
        body = m.content;
        sourceConversation = m.cid;
        sourceTitle = m.title;
        sourceMessage = m.id;
      }
      if (size > LIMIT) throw new ParaError(413, "首版单份资料最大 64 MiB。");
      if (source) {
        if (!fs.existsSync(source) || !fs.statSync(source).isFile())
          throw new ParaError(409, "来源文件暂不可用，请恢复后重试。");
        if (fs.statSync(source).size !== size)
          throw new ParaError(409, "来源文件已变化，请重试。");
        sha = digest(fs.readFileSync(source));
      }
      if (!source && !body.trim() && !d.url)
        throw new ParaError(400, "请输入文字、链接或选择文件。");
      const result = store.once(u, d.key, operation, () => {
        quota(u, size);
        const rid = crypto.randomUUID();
        if (source) {
          destination = path.dirname(resourcePath(config.tenantRoot, u, rid));
          fs.mkdirSync(destination, { recursive: true, mode: 0o700 });
          const target = path.join(destination, "content");
          fs.copyFileSync(source, target, fs.constants.COPYFILE_EXCL);
          fs.chmodSync(target, 0o600);
          if (digest(fs.readFileSync(target)) !== sha)
            throw new ParaError(409, "文件校验失败，请重试。");
        }
        const resource = store.insertResource(
          u,
          {
            id: rid,
            board_id: bid,
            area_id: d.area_id ?? null,
            title: d.title ?? fileName ?? (d.url || body).slice(0, 80),
            kind: source
              ? "file"
              : d.source_message_id
                ? "excerpt"
                : d.url
                  ? "link"
                  : "note",
            body,
            url: d.url,
            file_name: fileName,
            mime_type: mime,
            size,
            sha256: sha,
            source_conversation_id: sourceConversation,
            source_message_id: sourceMessage,
            source_file_id: sourceFile,
            source_title: sourceTitle,
          },
          d.projectId,
          d.is_output === "true",
        );
        return { resource };
      });
      res.status(201).json(result);
    } catch (e) {
      if (destination) fs.rmSync(destination, { recursive: true, force: true });
      throw e;
    } finally {
      if (uploaded) fs.rmSync(uploaded.path, { force: true });
    }
  });
  api.patch("/para/resources/:id", (req, res) => {
    const d = z
      .object({
        revision: rev,
        title: title.optional(),
        body: text.optional(),
        url: url.optional(),
        area_id: uuid.nullable().optional(),
        archived: z.boolean().optional(),
      })
      .parse(req.body);
    res.json({
      resource: store.updateResource(user(res), String(req.params.id), d),
    });
  });
  api.get("/para/resources/:id", (req, res) =>
    res.json({ resource: store.resource(user(res), String(req.params.id)) }),
  );
  api.get("/para/resources/:id/content", (req, res) => {
    const r = store.resource(user(res), String(req.params.id));
    if (r.kind !== "file")
      return res.status(400).json({ error: "这份资料没有文件。" });
    const f = readResourceFile(config.tenantRoot, r);
    res.setHeader("Content-Security-Policy", "sandbox; default-src 'none'");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.type(r.mime_type ?? "application/octet-stream");
    if (r.mime_type?.startsWith("text/"))
      res.setHeader(
        "Content-Type",
        r.mime_type.split(";")[0] + "; charset=utf-8",
      );
    return res.download(path.basename(f), r.file_name ?? r.title, {
      root: path.dirname(f),
      dotfiles: "deny",
    });
  });
  api.get("/para/resources/:id/preview", (req, res) => {
    const r = store.resource(user(res), String(req.params.id));
    if (r.kind !== "file") return res.json({ resource: r, content: r.body });
    if (
      r.size > 2 * 1024 * 1024 ||
      !(
        /\.(txt|md|markdown|html?|csv|json|xml|log)$/i.test(
          r.file_name ?? "",
        ) || r.mime_type?.startsWith("text/")
      )
    )
      return res.json({ resource: r, content: null });
    return res.json({
      resource: r,
      content: fs.readFileSync(readResourceFile(config.tenantRoot, r), "utf8"),
    });
  });
  api.put("/para/projects/:id/resources/:rid", (req, res) => {
    const d = z
      .object({
        is_output: z.boolean().default(false),
        pinned: z.boolean().default(false),
      })
      .parse(req.body);
    store.transaction(() =>
      store.linkResource(
        user(res),
        String(req.params.id),
        String(req.params.rid),
        d.is_output,
        d.pinned,
      ),
    );
    res.status(204).end();
  });
  api.delete("/para/projects/:id/resources/:rid", (req, res) => {
    const u = user(res),
      pid = String(req.params.id);
    store.project(u, pid);
    store.sql
      .prepare(
        "DELETE FROM para_resource_links WHERE project_id=? AND resource_id=?",
      )
      .run(pid, String(req.params.rid));
    store.event(u, pid, "移除资料引用");
    res.status(204).end();
  });
  // Permanent removal is deliberately separate from reversible archiving.
  api.delete("/para/projects/:id", (req, res) => {
    const u = user(res),
      pid = String(req.params.id),
      p = store.project(u, pid);
    const d = z.object({ revision: rev }).parse(req.body);
    store.revision(p.revision, d.revision);
    if (!p.archived_at) throw new ParaError(409, "请先归档项目。");
    store.sql
      .prepare("DELETE FROM para_projects WHERE id=? AND user_id=?")
      .run(pid, u);
    res.status(204).end();
  });
  api.delete("/para/resources/:id", (req, res) => {
    const u = user(res),
      r = store.resource(u, String(req.params.id));
    const d = z.object({ revision: rev }).parse(req.body);
    store.revision(r.revision, d.revision);
    if (
      !r.archived_at ||
      store.sql
        .prepare("SELECT 1 FROM para_resource_links WHERE resource_id=?")
        .get(r.id)
    )
      throw new ParaError(409, "只有已归档且没有项目引用的资料可以删除。");
    store.sql
      .prepare("DELETE FROM para_resources WHERE id=? AND user_id=?")
      .run(r.id, u);
    if (r.kind === "file")
      fs.rmSync(path.dirname(resourcePath(config.tenantRoot, u, r.id)), {
        recursive: true,
        force: true,
      });
    res.status(204).end();
  });
  api.delete("/para/boards/:id", (req, res) => {
    const u = user(res),
      bid = String(req.params.id),
      b = store.board(u, bid);
    const d = z.object({ revision: rev }).parse(req.body);
    store.revision(b.revision, d.revision);
    if (store.projects(u, bid).length || store.resources(u, bid).length)
      throw new ParaError(409, "请先整理看板中的项目与资料。");
    store.sql
      .prepare("DELETE FROM para_boards WHERE id=? AND user_id=?")
      .run(bid, u);
    res.status(204).end();
  });
  api.use(
    "/para",
    (
      err: unknown,
      _req: unknown,
      res: import("express").Response,
      next: import("express").NextFunction,
    ) => {
      if (err instanceof ParaError)
        return res.status(err.status).json({ error: err.message });
      if (err instanceof z.ZodError)
        return res
          .status(400)
          .json({ error: err.issues[0]?.message ?? "输入格式有误。" });
      if (err instanceof multer.MulterError)
        return res
          .status(413)
          .json({ error: "资料上传失败，首版每次最多一个文件，最大 64 MiB。" });
      next(err);
    },
  );
}
