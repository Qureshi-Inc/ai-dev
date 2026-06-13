import { z } from "zod";
import { callModelJson } from "../llm/client.js";
import { debugPrompt } from "../llm/prompts.js";
import { TaskType, type DebugResult, type IssueSpec } from "../types.js";
import { fileTree } from "../utils/git.js";
import { readFileSafe } from "./context.js";
import type { RepoFileContext } from "../llm/prompts.js";
import { logger } from "../utils/logger.js";

// Keep the debug prompt small so it fits modest LM Studio context windows.
const DEBUG_MAX_FILES = 4;
const DEBUG_MAX_FILE_BYTES = 6000;

const DebugSchema = z.object({
  rootCause: z.string().optional(),
  fixInstructions: z.string().optional(),
  suspectedFiles: z.array(z.string()).optional(),
});

/** Analyse a CI failure with the debug model and return a root cause + fix plan. */
export async function analyzeFailure(args: {
  jobId: number;
  dir: string;
  spec: IssueSpec;
  logsExcerpt: string;
  changedFiles: string[];
  pro?: boolean;
}): Promise<DebugResult> {
  const tree = await fileTree(args.dir, 200);
  const changedFiles: RepoFileContext[] = [];
  for (const path of args.changedFiles.slice(0, DEBUG_MAX_FILES)) {
    const content = readFileSafe(args.dir, path, DEBUG_MAX_FILE_BYTES);
    if (content !== null) changedFiles.push({ path, content });
  }

  const prompt = debugPrompt({
    spec: args.spec,
    logsExcerpt: args.logsExcerpt,
    changedFiles,
    fileTree: tree,
  });

  const raw = await callModelJson<unknown>(TaskType.CI_ANALYSIS, {
    system: prompt.system,
    user: prompt.user,
    jobId: args.jobId,
    pro: args.pro,
  });

  const parsed = DebugSchema.parse(raw);
  const result: DebugResult = {
    rootCause: parsed.rootCause || "Unknown root cause; see CI logs.",
    fixInstructions:
      parsed.fixInstructions || "Re-examine the failing tests and correct the implementation.",
    suspectedFiles: parsed.suspectedFiles ?? [],
  };
  logger.info({ jobId: args.jobId, suspectedFiles: result.suspectedFiles }, "debug analysis complete");
  return result;
}
