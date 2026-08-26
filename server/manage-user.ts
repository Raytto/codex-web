import crypto from "node:crypto";
import bcrypt from "bcryptjs";
import { loadConfig } from "./config.js";
import { AppDatabase } from "./db.js";
import { ensureTenant, newId } from "./paths.js";
import { HOST_ROOT_USER_ID, HOST_ROOT_USERNAME } from "./host-root-user.js";
import { ensureTenantProjectLayout } from "./tenant-projects.js";
import { ensurePersonalMemoryLibrary } from "./personal-memory-files.js";

const [command, rawUsername, rawDisplayName] = process.argv.slice(2);
const config = loadConfig();
const db = new AppDatabase(config.dataRoot, {
  username: config.username,
  passwordHash: config.passwordHash,
  displayName: "Codex",
}, false);

function usage(): never {
  throw new Error("Usage: manage-user <create|create-host-root|reset-password|enable|disable|list> [username] [display-name]");
}

function password(): string {
  return process.env.CWW_NEW_USER_PASSWORD || crypto.randomBytes(18).toString("base64url");
}

try {
  if (command === "list") {
    console.log(JSON.stringify(db.listUsers().map(({ password_hash: _passwordHash, ...user }) => user), null, 2));
  } else {
    const username = rawUsername?.trim().toLowerCase();
    if (!username || !/^[a-z0-9][a-z0-9._-]{1,31}$/.test(username)) usage();
    const existing = db.getUserByUsername(username);
    if (command === "create" || command === "create-host-root") {
      if (existing) throw new Error(`User already exists: ${username}`);
      if (command === "create-host-root" && username !== HOST_ROOT_USERNAME) {
        throw new Error(`The host root account username must be ${HOST_ROOT_USERNAME}`);
      }
      const initialPassword = password();
      const now = new Date().toISOString();
      const user = {
        id: command === "create-host-root" ? HOST_ROOT_USER_ID : newId(),
        username,
        display_name: rawDisplayName?.trim().slice(0, 60) || username,
        password_hash: bcrypt.hashSync(initialPassword, 12),
        role: "member" as const,
        status: "active" as const,
        created_at: now,
        updated_at: now,
      };
      db.createUser(user);
      const tenant = ensureTenant(config.tenantRoot, user.id);
      if (command !== "create-host-root") ensureTenantProjectLayout(tenant);
      ensurePersonalMemoryLibrary(tenant.library, user.username);
      console.log(JSON.stringify({ created: true, userId: user.id, username, displayName: user.display_name, initialPassword }));
    } else if (command === "reset-password") {
      if (!existing) throw new Error(`User not found: ${username}`);
      const initialPassword = password();
      db.setUserPassword(existing.id, bcrypt.hashSync(initialPassword, 12));
      console.log(JSON.stringify({ reset: true, userId: existing.id, username, initialPassword }));
    } else if (command === "enable" || command === "disable") {
      if (!existing) throw new Error(`User not found: ${username}`);
      db.setUserStatus(existing.id, command === "enable" ? "active" : "disabled");
      console.log(JSON.stringify({ updated: true, userId: existing.id, username, status: command === "enable" ? "active" : "disabled" }));
    } else {
      usage();
    }
  }
} finally {
  db.close();
}
