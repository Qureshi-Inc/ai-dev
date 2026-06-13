import { z } from "zod";
import { callModel, extractJson } from "../llm/client.js";
import { implementPrompt } from "../llm/prompts.js";
import { TaskType, type FileEdit, type ImplementResult, type IssueSpec } from "../types.js";
import { fileTree } from "../utils/git.js";
import { applyEdits, type AppliedEdit } from "../utils/patch.js";
import { selectContextFiles } from "./context.js";
import { logger } from "../utils/logger.js";

const ImplementSchema = z.object({
  commitMessage: z.string().optional(),
  summary: z.string().optional(),
  files: z
    .array(
      z.object({
        path: z.string(),
        action: z.enum(["create", "modify", "delete", "edit"]).default("modify"),
        content: z.string().default(""),
        search: z.string().optional(),
        replace: z.string().optional(),
      }),
    )
    .default([]),
});

export interface ImplementOutcome {
  result: ImplementResult;
  applied: AppliedEdit[];
}

/**
 * Parse the sentinel-delimited implement format. Handles two block types in
 * document order:
 *   - @@FILE <path> <create|modify|delete> ... @@END  (full file content)
 *   - @@EDIT <path> with <<<<<<< SEARCH / ======= / >>>>>>> REPLACE ... @@END
 * Returns null if no blocks of either kind are found.
 */
function parseDelimited(text: string): ImplementResult | null {
  const blockRe = new RegExp(
    // @@FILE block: groups 1=path, 2=action, 3=content
    "@@FILE[ \\t]+(\\S+)[ \\t]+(create|modify|delete)[ \\t]*\\r?\\n([\\s\\S]*?)\\r?\\n?@@END" +
      "|" +
      // @@EDIT block: groups 4=path, 5=search, 6=replace
      "@@EDIT[ \\t]+(\\S+)[ \\t]*\\r?\\n" +
      "<<<<<<< SEARCH\\r?\\n([\\s\\S]*?)\\r?\\n?=======\\r?\\n([\\s\\S]*?)\\r?\\n?>>>>>>> REPLACE[ \\t]*\\r?\\n?@@END",
    "g",
  );
  const files: FileEdit[] = [];
  let m: RegExpExecArray | null;
  while ((m = blockRe.exec(text)) !== null) {
    if (m[1] !== undefined) {
      const action = m[2] as FileEdit["action"];
      files.push({ path: m[1], action, content: action === "delete" ? "" : m[3] });
    } else if (m[4] !== undefined) {
      files.push({ path: m[4], action: "edit", content: "", search: m[5], replace: m[6] });
    }
  }
  if (files.length === 0) return null;

  const commitMessage = text.match(/^COMMIT:[ \t]*(.+)$/m)?.[1]?.trim() || "ai-dev: implement changes";
  const summary = text.match(/^SUMMARY:[ \t]*(.+)$/m)?.[1]?.trim() || "";
  return { commitMessage, summary, files };
}

/** Fallback: parse the older JSON implement format if the model used it. */
function parseJsonFallback(text: string): ImplementResult | null {
  try {
    const parsed = ImplementSchema.parse(extractJson<unknown>(text));
    if (parsed.files.length === 0) return null;
    return {
      commitMessage: parsed.commitMessage || "ai-dev: implement changes",
      summary: parsed.summary || "",
      files: parsed.files,
    };
  } catch {
    return null;
  }
}

/**
 * Implement (or fix) changes with the code model: gather repo context, request
 * full-file edits as JSON, validate, and apply them to the working tree.
 */
export async function implementChanges(args: {
  jobId: number;
  dir: string;
  spec: IssueSpec;
  steps: string[];
  fixInstructions?: string;
  extraContextFiles?: string[];
  attempt?: number;
  pro?: boolean;
  /** Implement only this plan step (0-based). Earlier steps already applied. */
  stepIndex?: number;
  /** Epic mode: instruct feature-flagging of new behavior. */
  epic?: boolean;
}): Promise<ImplementOutcome> {
  const tree = await fileTree(args.dir);
  const files = await selectContextFiles(args.dir, args.spec, args.extraContextFiles ?? []);

  const prompt = implementPrompt({
    spec: args.spec,
    steps: args.steps,
    files,
    fileTree: tree,
    fixInstructions: args.fixInstructions,
    stepIndex: args.stepIndex,
    epic: args.epic,
  });

  const response = await callModel(TaskType.IMPLEMENT, {
    system: prompt.system,
    user: prompt.user,
    jobId: args.jobId,
    attempt: args.attempt,
    pro: args.pro,
  });

  const result = parseDelimited(response.text) ?? parseJsonFallback(response.text);
  if (!result) {
    throw new Error("implement response contained no parseable output");
  }
  // A stepwise call may legitimately produce no file changes for a given step.
  if (result.files.length === 0 && typeof args.stepIndex !== "number") {
    throw new Error("implement response contained no parseable file edits");
  }

  const applied = applyEdits(args.dir, result.files);
  logger.info(
    { jobId: args.jobId, files: applied.map((a) => `${a.action}:${a.path}`) },
    "patch applied",
  );
  return { result, applied };
}
