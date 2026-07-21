import fs from "node:fs";
import path from "node:path";

const MANAGED_SKILLS = ["local-spreadsheets"] as const;
const syncedDestinations = new Set<string>();

export function syncManagedSkills(codexHome: string, sourceRoot = path.join(process.cwd(), "skills")): void {
  const resolvedCodexHome = path.resolve(codexHome);
  const skillsRoot = path.join(resolvedCodexHome, "skills");
  fs.mkdirSync(skillsRoot, { recursive: true });
  for (const skillName of MANAGED_SKILLS) {
    const source = path.resolve(sourceRoot, skillName);
    const destination = path.resolve(skillsRoot, skillName);
    if (path.dirname(destination) !== skillsRoot) throw new Error("Invalid managed skill destination");
    if (syncedDestinations.has(destination)) continue;
    if (!fs.existsSync(source) || !fs.statSync(source).isDirectory() || !fs.existsSync(path.join(source, "SKILL.md"))) {
      throw new Error(`Managed skill source is incomplete: ${skillName}`);
    }
    fs.rmSync(destination, { recursive: true, force: true });
    fs.cpSync(source, destination, { recursive: true, force: true });
    syncedDestinations.add(destination);
  }
}
