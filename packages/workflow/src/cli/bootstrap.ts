// First-run config bootstrap for `aow run`. If the cwd has no
// agent-orchestrator.yaml, write a minimal flat config so the workflow
// engine can resolve a project without manual setup.

import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";

import { WorkflowError } from "../errors.js";

export interface BootstrapResult {
  configPath: string;
  projectId: string;
  created: boolean;
}

const SCHEMA_URL =
  "https://raw.githubusercontent.com/ComposioHQ/agent-orchestrator/main/schema/config.schema.json";

function sanitizeProjectId(raw: string): string {
  const lowered = raw.toLowerCase();
  const replaced = lowered.replace(/[^a-z0-9_-]/g, "_");
  const trimmed = replaced.replace(/_+$/g, "");
  return trimmed || "project";
}

async function readIfExists(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

function parseProjectId(yamlText: string, fallback: string): string {
  // Flat config: `name: foo` at top level.
  const nameMatch = yamlText.match(/^name:\s*["']?([A-Za-z0-9_.-]+)["']?\s*$/m);
  if (nameMatch) return sanitizeProjectId(nameMatch[1]);
  // Wrapped config: first key under `projects:`.
  const projIdx = yamlText.search(/^projects:\s*$/m);
  if (projIdx >= 0) {
    const after = yamlText.slice(projIdx);
    const keyMatch = after.match(/^\s{2,}([A-Za-z0-9_.-]+):\s*$/m);
    if (keyMatch) return sanitizeProjectId(keyMatch[1]);
  }
  return fallback;
}

function renderFlatConfig(projectId: string, cwd: string): string {
  return [
    `$schema: ${SCHEMA_URL}`,
    `name: ${projectId}`,
    `path: ${cwd}`,
    `defaultBranch: main`,
    `sessionPrefix: aow`,
    `agent: claude-code`,
    `workspace: worktree`,
    ``,
  ].join("\n");
}

async function atomicWrite(target: string, contents: string): Promise<void> {
  const tmp = `${target}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(tmp, contents, { flag: "wx" });
  try {
    await rename(tmp, target);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") return;
    throw err;
  }
}

export async function ensureAowConfig(cwd: string): Promise<BootstrapResult> {
  const yamlPath = join(cwd, "agent-orchestrator.yaml");
  const ymlPath = join(cwd, "agent-orchestrator.yml");
  try {
    const existing = (await readIfExists(yamlPath)) ?? (await readIfExists(ymlPath));
    if (existing !== null) {
      const path = (await readIfExists(yamlPath)) !== null ? yamlPath : ymlPath;
      const fallback = sanitizeProjectId(basename(cwd));
      return { configPath: path, projectId: parseProjectId(existing, fallback), created: false };
    }

    await mkdir(cwd, { recursive: true });
    const projectId = sanitizeProjectId(basename(cwd));
    const contents = renderFlatConfig(projectId, cwd);
    try {
      await atomicWrite(yamlPath, contents);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "EEXIST") {
        const raced = (await readIfExists(yamlPath)) ?? "";
        return {
          configPath: yamlPath,
          projectId: parseProjectId(raced, projectId),
          created: false,
        };
      }
      throw err;
    }
    return { configPath: yamlPath, projectId, created: true };
  } catch (err) {
    if (err instanceof WorkflowError) throw err;
    throw new WorkflowError(
      "WF_AO_CONTEXT",
      `Failed to ensure agent-orchestrator.yaml in ${cwd}: ${err instanceof Error ? err.message : String(err)}`,
      { cause: err },
    );
  }
}
