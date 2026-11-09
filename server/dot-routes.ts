import type { Router, Request, Response } from 'express';
import type { JobRow, SessionRow } from './db.js';
import { DotError, DotStore } from './dot-store.js';
import { projectDot } from './dot-projection.js';
import type { DotLiveGateway } from './dot-live.js';
const fail = (res: Response, e: unknown) => res.status(e instanceof DotError ? e.status : 400).json({ error: e instanceof Error ? e.message : 'PP Dot 操作失败' });
export type DotActions = {
    changed: (cid: string) => void;
    cancel: (id: string) => boolean;
    steer?: (pendingId: string) => Promise<{mode:string;message:string}>;
};
export async function dotAction(store: DotStore, user: string, action: string, id: string, data: Record<string, unknown>, hooks: DotActions) {
    store.owner(user);
    if (action === 'context')
        return store.context(user);
    if (action === 'task_list') {
        store.reconcile(user);
        return { tasks: store.tasks(user) };
    }
    if (action === 'task_detail') {
        store.reconcile(user);
        const task = store.task(user, id);
        const created = store.sql.prepare("SELECT content FROM dot_events WHERE user_id=? AND kind='task_created' AND source_id=?").get(user,id) as {content:string}|undefined;
        return { task, routing:created ? JSON.parse(created.content).routing : undefined, job:store.sql.prepare('SELECT id,status FROM jobs WHERE conversation_id=? ORDER BY created_at DESC,rowid DESC LIMIT 1').get(task.conversation_id), resultMessage:store.sql.prepare("SELECT id,content FROM messages WHERE conversation_id=? AND role='assistant' ORDER BY created_at DESC,rowid DESC LIMIT 1").get(task.conversation_id), files: store.db.listFiles(task.conversation_id).filter(f => f.kind === 'output') };
    }
    if (action === 'search') {
        if(typeof data.sourceId==='string') return {events:store.sql.prepare('SELECT seq,kind,source_id,content,created_at FROM dot_events WHERE user_id=? AND source_id=?').all(user,data.sourceId)};
        const q = String(data.query ?? '').trim().slice(0, 200);
        if (!q)
            throw new DotError(400, '请输入检索词。');
        return { events: store.sql.prepare('SELECT seq,kind,source_id,content,created_at FROM dot_events WHERE user_id=? AND content LIKE ? ORDER BY seq DESC LIMIT 30').all(user, `%${q}%`), memories:store.memories(user).filter(m=>m.content.includes(q)) };
    }
    if (action === 'task_preview') return store.previewTask(user, data);
    if (action === 'task_create') {
        await store.prepareTask(user, data);
        const task = store.createTask(user, data);
        hooks.changed(task.conversation_id);
        return { task };
    }
    if (action === 'task_review') return {task:store.reviewTask(user,id,data)};
    if (action === 'task_steer') {
        const result = store.correctTask(user, id, data);
        const delivery = await hooks.steer?.(result.pendingId);
        hooks.changed(result.task.conversation_id);
        return {...result,...delivery};
    }
    if (action === 'task_cancel') {
        const result = store.operation(user, data.requestKey, 'task_cancel:' + id, data, () => { const t = store.task(user, id); if (t.revision !== data.revision)
            throw new DotError(409, '任务版本已变化。'); for (const p of store.db.listPendingPrompts(t.conversation_id))
            store.db.deletePendingPrompt(p.id); for (const j of store.db.listActiveJobsForConversation(t.conversation_id))
            if (j.status === 'queued')
                store.db.cancelQueuedJob(j.id); store.sql.prepare("UPDATE dot_tasks SET revision=revision+1,state='cancel_requested',updated_at=? WHERE id=?").run(new Date().toISOString(), id); store.event(user, 'cancel_requested', String(data.requestKey), JSON.stringify({ taskId: id })); return { task: store.task(user, id), jobIds: store.db.listActiveJobsForConversation(t.conversation_id).filter(j=>j.status==='running').map(j=>j.id) }; });
        for (const jobId of result.jobIds)
            if (store.db.getJob(jobId)?.status === 'running') hooks.cancel(jobId);
        store.reconcile(user);
        return { task: store.task(user, id) };
    }
    if (action === 'memory_put' || action === 'memory_forget') {
        const result=store.memory(user, data, action === 'memory_forget');
        return {...result,projection:projectDot(store,user)};
    }
    if (action === 'checkpoint')
        return store.checkpoint(user);
    throw new DotError(400, '不支持的 PP Dot 操作。');
}
export function mountDotAutomation(api: Router, store: DotStore, auth: (req: Request) => JobRow | null, hooks: DotActions) { api.post('/automation/jobs/:jobId/dot', async (req, res) => { try {
    const job = auth(req);
    if (!job)
        return res.status(401).json({ error: '任务凭据无效。' });
    const c = store.db.getConversation(job.conversation_id);
    if (!c)
        throw new DotError(403, '会话不可用。');
    store.requireCoordinator(c.user_id, c.id);
    return res.json(await dotAction(store, c.user_id, String(req.body?.action), String(req.body?.id ?? ''), req.body?.data ?? {}, hooks));
}
catch (e) {
    return fail(res, e);
} }); }
export function mountDotRoutes(api: Router, store: DotStore, live: DotLiveGateway, hooks: DotActions) {
    const user = (res: Response) => (res.locals.session as SessionRow).user_id;
    api.post('/dot/open', (req, res) => { try {
        const c = store.init(user(res));
        hooks.changed(c.id);
        return res.json({ conversation: c });
    }
    catch (e) {
        return fail(res, e);
    } });
    api.get('/dot', (req, res) => { try {
        return res.json(store.context(user(res)));
    }
    catch (e) {
        return fail(res, e);
    } });
    api.get('/dot/events', (req, res) => { try {
        return res.json({ events: store.events(user(res), Math.max(0, Number(req.query.after) || 0)) });
    }
    catch (e) {
        return fail(res, e);
    } });
    api.post('/dot/action', async (req, res) => { try {
        return res.json(await dotAction(store, user(res), String(req.body?.action), String(req.body?.id ?? ''), req.body?.data ?? {}, hooks));
    }
    catch (e) {
        return fail(res, e);
    } });
    api.post('/dot/call', (req, res) => { try {
        store.owner(user(res));
        return res.json(live.ticket(res.locals.session as SessionRow, req.body?.takeover === true));
    }
    catch (e) {
        return fail(res, e);
    } });
}
