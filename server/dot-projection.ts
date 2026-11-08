import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import type { DotStore } from './dot-store.js';
const hash = (s: string) => crypto.createHash('sha256').update(s).digest('hex');
export function projectDot(store: DotStore, user: string) {
    const root = store.projectionRoot ?? process.env.PP_DOT_PROJECTION_DIR;
    if (!root)
        return { ok: false, message: '台账文件投影目录未配置；数据库记录仍有效。' };
    try {
        const dir = fs.lstatSync(root);
        if (!dir.isDirectory() || dir.isSymbolicLink())
            throw Error('投影目录不是普通目录。');
        const memories = store.memories(user), tasks = store.tasks(user);
        const seq = Number(store.sql.prepare('SELECT COALESCE(MAX(seq),0) AS seq FROM dot_events WHERE user_id=?').get(user)?.seq ?? 0);
        const header = `<!-- PP Dot projection v1; event watermark ${seq}; authoritative state: platform database -->\n`;
        const files: Record<string, string> = { 'README.md': header + '# PP Dot 协调记录\n\n本目录仅保存平台数据库的可重建投影。业务产物在真实目标项目。请在 PP Dot 界面或会话中纠正记忆；手工修改会阻止覆盖，并提示核对。\n', 'tasks.md': header + '# 任务台账\n\n' + tasks.map(t => `- ${t.title} · ${t.state} · revision ${t.revision}\n  - task: ${t.id}; project: ${t.project_id}; executor: ${t.executor_id}; conversation: ${t.conversation_id}; source: ${t.source_id}`).join('\n'), 'decisions.md': header + '# 已确认记忆与决定\n\n' + memories.filter(m => m.state === 'confirmed').map(m => `- ${m.content}\n  - memory: ${m.id}; revision: ${m.revision}; source: ${m.source_id}`).join('\n'), 'context.md': header + '# 当前协调摘要\n\n' + tasks.filter(t => !['completed', 'failed', 'cancelled'].includes(t.state)).map(t => `- ${t.title}: ${t.state} (${t.id})`).join('\n') + '\n\n待确认记忆：' + memories.filter(m => m.state === 'candidate').length + '。已遗忘内容不进入此投影。\n' };
        for (const [name, content] of Object.entries(files)) {
            const dest = path.join(root, name);
            const old = store.sql.prepare('SELECT hash FROM dot_projections WHERE user_id=? AND name=?').get(user, name) as {
                hash: string;
            } | undefined;
            if (fs.existsSync(dest)) {
                const st = fs.lstatSync(dest);
                if (!st.isFile() || st.isSymbolicLink())
                    throw Error(`${name} 不是普通文件。`);
                const current = hash(fs.readFileSync(dest, 'utf8'));
                if (current === hash(content))
                    continue;
                if (!old || current !== old.hash)
                    throw Error(`${name} 有手工修改，已保留；请在界面核对后自行移走副本再重建。`);
            }
            const tmp = path.join(root, `.${name}.${crypto.randomUUID()}.tmp`);
            fs.writeFileSync(tmp, content, { mode: 0o600, flag: 'wx' });
            fs.renameSync(tmp, dest);
            store.sql.prepare('INSERT INTO dot_projections VALUES(?,?,?) ON CONFLICT(user_id,name) DO UPDATE SET hash=excluded.hash').run(user, name, hash(content));
        }
        return { ok: true, watermark: seq };
    }
    catch (e) {
        return { ok: false, message: e instanceof Error ? e.message : '投影失败' };
    }
}
