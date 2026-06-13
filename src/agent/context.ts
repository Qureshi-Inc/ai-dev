import { readFileSync } from "node:fs";
import { join } from "node:path";
import { config } from "../config.js";
import { listTrackedFiles } from "../utils/git.js";
import type { RepoFileContext } from "../llm/prompts.js";
import type { IssueSpec } from "../types.js";

const SOURCE_EXT =
  /\.(ts|tsx|js|jsx|mjs|cjs|py|go|rs|java|rb|c|cc|cpp|h|hpp|cs|php|sh|sql|yml|yaml|toml|json|md)$/i;
const IMPORTANT =
  /^(package\.json|tsconfig.*\.json|readme\.md|requirements\.txt|pyproject\.toml|go\.mod|cargo\.toml|makefile|dockerfile)$/i;

export function readFileSafe(dir: string, rel: string, maxBytes: number): string | null {
  try {
    const buf = readFileSync(join(dir, rel));
    if (buf.length > maxBytes) {
      return `${buf.toString("utf8", 0, maxBytes)}\n...[truncated ${buf.length - maxBytes} bytes]`;
    }
    return buf.toString("utf8");
  } catch {
    return null;
  }
}

/** Read specific files (used for changed/suspect file context in the debug step). */
export function readFiles(dir: string, paths: string[]): RepoFileContext[] {
  const out: RepoFileContext[] = [];
  for (const path of paths) {
    const content = readFileSafe(dir, path, config.llm.implementMaxFileBytes);
    if (content !== null) out.push({ path, content });
  }
  return out;
}

/**
 * Pick a bounded set of repo files to feed the implementer as context:
 * spec-referenced + extra (changed/suspect) files first, then important config
 * files, then a sample of source files up to the configured cap.
 */
export async function selectContextFiles(
  dir: string,
  spec: IssueSpec,
  extra: string[] = [],
): Promise<RepoFileContext[]> {
  const tracked = await listTrackedFiles(dir);
  const picked = new Set<string>();

  for (const hint of [...extra, ...spec.affectedAreas]) {
    if (!hint) continue;
    for (const f of tracked) {
      if (f === hint || f.includes(hint) || hint.includes(f)) picked.add(f);
    }
  }

  for (const f of tracked) {
    if (IMPORTANT.test(f)) picked.add(f);
  }

  for (const f of tracked) {
    if (picked.size >= config.llm.implementContextFiles) break;
    if (SOURCE_EXT.test(f)) picked.add(f);
  }

  const limited = [...picked].slice(0, config.llm.implementContextFiles);
  return readFiles(dir, limited);
}
