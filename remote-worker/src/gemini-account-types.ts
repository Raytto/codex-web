import type { AgentOptions } from "./protocol.js";
import type { AntigravityUsage } from "./antigravity-usage-types.js";
export type GeminiAccountView = { id: string; label: string; email: string | null; createdAt: string; lastUsedAt: string | null; active: boolean; authenticated: boolean };
export type GeminiAccountsState = { accounts: GeminiAccountView[]; activeAccountId: string | null; runtimeAvailable: boolean; loginAvailable?: boolean; error?: string };
export type GeminiAccountLoginView = { id: string; label: string; status: "starting" | "waiting" | "completed" | "failed" | "cancelled"; verificationUrl: string | null; requiresCode: boolean; message: string | null; accountId: string | null; createdAt: string; expiresAt: string };
export type GeminiAccountAction = "list" | "catalog" | "usage" | "login_start" | "login_status" | "login_cancel" | "login_code" | "activate" | "delete";
export type GeminiAccountRequest = { action: GeminiAccountAction; label?: string; loginId?: string; accountId?: string; code?: string; refresh?: boolean };
export type GeminiAccountResult = { state?: GeminiAccountsState; login?: GeminiAccountLoginView; catalog?: AgentOptions | null; usage?: AntigravityUsage };
