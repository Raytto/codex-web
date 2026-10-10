import type { Router, Request, Response } from "express";
import type { AppDatabase, SessionRow } from "./db.js";
import type { AgentSelection } from "./model-options.js";
import type { RecurringInput } from "../src/recurring-types.js";
import { validateRecurrence } from "./recurrence.js";
import { RecurringStore, RecurringConflict } from "./recurring-store.js";

export function mountRecurringRoutes(api: Router, db: AppDatabase, select: (user: string, executor: string, model: unknown, effort: unknown) => AgentSelection) {
  const store = new RecurringStore(db);
  const owner = (res: Response) => (res.locals.session as SessionRow).user_id;
  function input(body: Record<string, unknown>, user: string, executor: string): RecurringInput {
    const name = typeof body.name === "string" ? body.name.trim() : "";
    const prompt = typeof body.prompt === "string" ? body.prompt.trim() : "";
    if (!name || name.length > 120) throw new Error("任务名称须为 1 至 120 字。");
    if (!prompt || prompt.length > 20_000) throw new Error("任务指令须为 1 至 20000 字。");
    const maxRuns = body.maxRuns === null ? null : body.maxRuns;
    if (maxRuns !== null && (typeof maxRuns !== "number" || !Number.isInteger(maxRuns) || maxRuns < 1 || maxRuns > 100000)) throw new Error("重复次数须为 1 至 100000，或选择不限次数。");
    return { name, prompt, ...select(user, executor, body.model, body.reasoningEffort), maxRuns, schedule: validateRecurrence(body.schedule) };
  }
  function handle(fn: (req: Request, res: Response) => unknown) {
    return (req: Request, res: Response) => { try { return fn(req, res); } catch (error) { return res.status(error instanceof RecurringConflict ? 409 : 400).json({ error: error instanceof Error ? error.message : "周期任务操作失败" }); } };
  }
  api.get("/projects/:id/scheduled-waits", handle((req, res) => {
    const user = owner(res), project = db.getActiveProjectForUser(String(req.params.id), user);
    if (!project) return res.status(404).json({ error: "项目不存在。" });
    return res.json({ waits: db.sqlite.prepare(`SELECT w.id,w.label,w.deadline_at,w.conversation_id FROM wake_plans w JOIN conversations c ON c.id=w.conversation_id WHERE c.user_id=? AND c.project_id=? AND c.deleted_at IS NULL AND w.state='armed' ORDER BY w.deadline_at`).all(user, project.id) });
  }));
  api.get("/recurring-tasks", handle((_req, res) => res.json({ tasks: store.list(owner(res)) })));
  api.post("/projects/:id/recurring-tasks", handle((req, res) => {
    const user = owner(res), project = db.getActiveProjectForUser(String(req.params.id), user);
    if (!project) return res.status(404).json({ error: "项目不存在。" });
    if (store.list(user).filter(t => t.project_id === project.id).length >= 100) return res.status(409).json({ error: "每个项目最多保留 100 个周期任务。" });
    return res.status(201).json({ task: store.create(user, project.id, input(req.body ?? {}, user, project.executor_id)) });
  }));
  api.get("/recurring-tasks/:id", handle((req, res) => {
    const task = store.get(owner(res), String(req.params.id));
    return task ? res.json({ task, runs: store.runs(owner(res), task.id) }) : res.status(404).json({ error: "周期任务不存在。" });
  }));
  api.patch("/recurring-tasks/:id", handle((req, res) => {
    const user = owner(res), task = store.get(user, String(req.params.id));
    if (!task) return res.status(404).json({ error: "周期任务不存在。" });
    if (!Number.isInteger(req.body?.revision)) throw new Error("任务版本无效。");
    if (!["active", "paused"].includes(req.body?.state)) throw new Error("任务状态无效。");
    const project = db.getActiveProjectForUser(task.project_id, user)!;
    return res.json({ task: store.update(user, task.id, req.body.revision, input(req.body, user, project.executor_id), req.body.state) });
  }));
  api.post("/recurring-tasks/:id/state", handle((req, res) => {
    const user = owner(res), task = store.get(user, String(req.params.id));
    if (!task) return res.status(404).json({ error: "周期任务不存在。" });
    if (!Number.isInteger(req.body?.revision) || !["active", "paused"].includes(req.body?.state)) throw new Error("任务版本或状态无效。");
    if (req.body.state === "active") {
      const project = db.getActiveProjectForUser(task.project_id, user)!;
      select(user, project.executor_id, task.model, task.reasoningEffort);
      if (task.maxRuns !== null && task.runCount >= task.maxRuns) throw new Error("已达到总次数，请先增加次数或选择不限次数。");
    }
    return res.json({ task: store.update(user, task.id, req.body.revision, task, req.body.state) });
  }));
  api.delete("/recurring-tasks/:id", handle((req, res) => {
    const task = store.get(owner(res), String(req.params.id));
    if (!task) return res.status(404).json({ error: "周期任务不存在。" });
    if (!Number.isInteger(req.body?.revision)) throw new Error("任务版本无效。");
    store.remove(owner(res), task.id, req.body.revision);
    return res.json({ ok: true });
  }));
}
