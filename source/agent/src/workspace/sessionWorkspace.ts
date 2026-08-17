import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

export const HSHH_RUNTIME_SKILLS = [
  "companion-character",
  "affect-reasoning",
  "consent-and-boundaries",
  "safe-skill-selection",
  "memory-governance",
  "avatar-pack-builder",
  "robot-diagnostics",
  "deep-research",
] as const;

function stableWorkspaceName(conversationKey: string): string {
  return createHash("sha256").update(conversationKey).digest("hex").slice(0, 24);
}

export function ensureSessionWorkspace(input: {
  sessionRoot: string;
  skillsRoot: string;
  conversationKey: string;
}): string {
  const workspace = resolve(
    input.sessionRoot,
    stableWorkspaceName(input.conversationKey),
  );
  const targetSkillsRoot = join(workspace, ".claude", "skills");
  mkdirSync(targetSkillsRoot, { recursive: true });

  for (const skill of HSHH_RUNTIME_SKILLS) {
    const source = resolve(input.skillsRoot, skill);
    if (!existsSync(source)) {
      throw new Error(`Required HSHH runtime skill is missing: ${skill}`);
    }
    const target = join(targetSkillsRoot, basename(source));
    cpSync(source, target, { recursive: true, force: true });
  }

  const sourceClaude = join(dirname(resolve(input.skillsRoot)), "CLAUDE.md");
  if (existsSync(sourceClaude)) {
    cpSync(sourceClaude, join(workspace, ".claude", "CLAUDE.md"), {
      force: true,
    });
  }
  return workspace;
}
