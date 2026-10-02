import {
  request,
  BASE_PATH,
  resumableUploadHeaders,
  type Conversation,
} from "./api";
import type {
  ParaBoard,
  ParaProject,
  ParaArea,
  ParaResource,
  ParaDetail,
  ParaConversation,
  ParaSidebarBoard,
  ParaSidebarProject,
  KanbanSummary,
  KanbanPreferences,
} from "../server/para-types";
export type BoardData = {
  board: ParaBoard;
  projects: ParaProject[];
  areas: ParaArea[];
  resources: ParaResource[];
};
export type SidebarProjectPage = { projects: ParaSidebarProject[]; total: number; nextOffset: number; hasMore: boolean };
export type ParaLink = {
  id: string;
  board_id: string;
  title: string;
  revision: number;
  relation: string;
};
export const newKey = () => crypto.randomUUID();
export const changed = (project?: ParaProject) => window.dispatchEvent(new CustomEvent("para-updated", { detail: { project } }));
async function write<T>(
  path: string,
  method: string,
  body?: unknown,
): Promise<T> {
  const r = await request<T>("/para" + path, {
    method,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  changed(r && typeof r === "object" && "project" in r ? r.project as ParaProject : undefined);
  return r;
}
export const para = {
  summary: () => request<KanbanSummary>("/para/summary"),
  updatePreferences: (revision: number, wip_limit: number) => write<{ preferences: KanbanPreferences }>("/preferences", "PATCH", { revision, wip_limit }),
  boards: () => request<{ boards: ParaBoard[] }>("/para/boards"),
  sidebar: (query: string, archived: boolean) => request<{ boards: ParaSidebarBoard[] }>(`/para/sidebar?q=${encodeURIComponent(query)}&archived=${Number(archived)}`),
  sidebarProjects: (id: string, query: string, archived: boolean, limit = 5, offset = 0) =>
    request<SidebarProjectPage>(`/para/boards/${id}/sidebar-projects?q=${encodeURIComponent(query)}&archived=${Number(archived)}&limit=${limit}&offset=${offset}`),
  reorderSidebarProjects: (sourceId: string, targetId: string, placement: "before" | "after") =>
    write<void>("/projects/reorder-sidebar", "POST", { sourceId, targetId, placement }),
  deleteProject: (id: string, revision: number) => write<void>("/projects/" + id, "DELETE", { revision }),
  board: (id: string) => request<BoardData>("/para/boards/" + id),
  createBoard: (body: unknown) =>
    write<{ board: ParaBoard }>("/boards", "POST", body),
  updateBoard: (id: string, body: unknown) =>
    write<{ board: ParaBoard }>("/boards/" + id, "PATCH", body),
  reorderBoards: (sourceId: string, targetId: string, placement: "before" | "after") =>
    write<{ boards: ParaBoard[] }>("/boards/reorder", "POST", { sourceId, targetId, placement }),
  deleteBoard: (id: string, revision: number) => write<void>("/boards/" + id, "DELETE", { revision }),
  createProject: (id: string, body: unknown) =>
    write<{ project: ParaProject }>(
      "/boards/" + id + "/projects",
      "POST",
      body,
    ),
  project: (id: string) => request<ParaDetail>("/para/projects/" + id),
  updateProject: (id: string, body: unknown) =>
    write<{ project: ParaProject }>("/projects/" + id, "PATCH", body),
  createArea: (id: string, body: unknown) =>
    write<{ area: ParaArea }>("/boards/" + id + "/areas", "POST", body),
  updateArea: (id: string, body: unknown) =>
    write<{ area: ParaArea }>("/areas/" + id, "PATCH", body),
  updateResource: (id: string, body: unknown) =>
    write<{ resource: ParaResource }>("/resources/" + id, "PATCH", body),
  preview: (id: string) =>
    request<{ resource: ParaResource; content: string | null }>(
      "/para/resources/" + id + "/preview",
    ),
  contentUrl: (id: string) => `${BASE_PATH}/api/para/resources/${id}/content`,
  linkResource: (pid: string, rid: string, body: unknown) =>
    write<void>(`/projects/${pid}/resources/${rid}`, "PUT", body),
  unlinkResource: (pid: string, rid: string) =>
    write<void>(`/projects/${pid}/resources/${rid}`, "DELETE"),
  linkConversations: (pid: string, ids: string[], primary?: boolean) =>
    write<ParaDetail>(`/projects/${pid}/conversations`, "POST", {
      ids,
      primary,
    }),
  unlinkConversation: (pid: string, cid: string) =>
    write<void>(`/projects/${pid}/conversations/${cid}`, "DELETE"),
  conversationProjects: (id: string) =>
    request<{ projects: ParaLink[] }>(`/para/conversations/${id}/projects`),
  searchConversations: (q: string, projectId: string) =>
    request<{ conversations: ParaConversation[] }>(
      `/para/conversations/search?q=${encodeURIComponent(q)}&projectId=${encodeURIComponent(projectId)}`,
    ),
  newConversation: (pid: string, body: unknown) =>
    write<{ conversation: Conversation }>(
      `/projects/${pid}/new-conversation`,
      "POST",
      body,
    ),
  upload: (
    bid: string,
    data: FormData,
    onProgress?: (percent: number) => void,
  ) =>
    new Promise<{ resource: ParaResource }>((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open("POST", `${BASE_PATH}/api/para/boards/${bid}/resources`);
      xhr.timeout = 180000;
      for (const [k, v] of Object.entries(resumableUploadHeaders()))
        xhr.setRequestHeader(k, v);
      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable)
          onProgress?.(Math.round((e.loaded / e.total) * 100));
      };
      xhr.onload = () => {
        let body;
        try {
          body = JSON.parse(xhr.responseText);
        } catch {
          reject(new Error("服务器响应异常，请重试。"));
          return;
        }
        if (xhr.status >= 200 && xhr.status < 300) {
          changed();
          resolve(body);
        } else reject(new Error(body.error || "资料保存失败，请重试。"));
      };
      xhr.onerror = () =>
        reject(new Error("网络连接中断，正文已保留，可重试。"));
      xhr.ontimeout = () => reject(new Error("上传超时，正文已保留，可重试。"));
      xhr.send(data);
    }),
};
