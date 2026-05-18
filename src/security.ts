import { lstat, mkdir, realpath, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import * as path from "node:path";

export function expandHome(input: string): string {
  const trimmed = input.trim();
  if (trimmed === "~") return homedir();
  if (trimmed.startsWith("~/")) return path.resolve(homedir(), trimmed.slice(2));
  return trimmed;
}

export function isPathInside(child: string, parent: string): boolean {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return relative === "" || (!!relative && !relative.startsWith("..") && !path.isAbsolute(relative));
}

export function workspaceRoots(baseCwd: string): string[] {
  const configured = (process.env.PI_WEB_ALLOWED_ROOTS || "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean)
    .map((value) => path.resolve(expandHome(value)));
  const roots = [path.resolve(baseCwd), ...configured];
  return [...new Set(roots)];
}

export async function realWorkspaceRoots(baseCwd: string): Promise<string[]> {
  const roots = await Promise.all(
    workspaceRoots(baseCwd).map(async (root) => {
      try {
        return await realpath(root);
      } catch {
        return path.resolve(root);
      }
    }),
  );
  return [...new Set(roots)];
}

export async function resolveReadableWorkspacePath(input: string, baseCwd: string): Promise<string> {
  const candidate = path.resolve(baseCwd, expandHome(input));
  const realCandidate = await realpath(candidate);
  const roots = await realWorkspaceRoots(baseCwd);
  if (!roots.some((root) => isPathInside(realCandidate, root))) {
    throw new Error("Path is outside the allowed workspace roots");
  }
  return realCandidate;
}

export async function resolveWritableWorkspacePath(input: string, baseCwd: string): Promise<string> {
  const candidate = path.resolve(baseCwd, expandHome(input));
  const roots = workspaceRoots(baseCwd);
  if (!roots.some((root) => isPathInside(candidate, root))) {
    throw new Error("Path is outside the allowed workspace roots");
  }

  await mkdir(path.dirname(candidate), { recursive: true });

  try {
    const existing = await lstat(candidate);
    if (existing.isSymbolicLink()) {
      throw new Error("Refusing to write through a symbolic link");
    }
  } catch (err: any) {
    if (err?.code !== "ENOENT") throw err;
  }

  const realParent = await realpath(path.dirname(candidate));
  const realRoots = await realWorkspaceRoots(baseCwd);
  if (!realRoots.some((root) => isPathInside(realParent, root))) {
    throw new Error("Path is outside the allowed workspace roots");
  }

  return candidate;
}

export async function assertDirectory(pathToCheck: string): Promise<void> {
  const s = await stat(pathToCheck);
  if (!s.isDirectory()) throw new Error("Path is not a directory");
}

export function safeSessionRoot(agentDir: string): string {
  return path.resolve(agentDir, "sessions");
}

export function resolveSessionFilePath(sessionFile: string, agentDir: string): string {
  if (!path.isAbsolute(sessionFile)) {
    throw new Error("sessionFile must be an absolute path");
  }
  const resolved = path.resolve(sessionFile);
  const root = safeSessionRoot(agentDir);
  if (!isPathInside(resolved, root)) {
    throw new Error("sessionFile is outside the pi sessions directory");
  }
  if (!resolved.endsWith(".jsonl")) {
    throw new Error("sessionFile must be a .jsonl file");
  }
  if (!existsSync(resolved)) {
    throw new Error("sessionFile does not exist");
  }
  return resolved;
}
