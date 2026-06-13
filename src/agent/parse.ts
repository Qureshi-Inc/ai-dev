import { z } from "zod";
import { callModelJson } from "../llm/client.js";
import { parseIssuePrompt } from "../llm/prompts.js";
import { TaskType, type IssueSpec } from "../types.js";

const SpecSchema = z.object({
  title: z.string().optional(),
  summary: z.string().optional(),
  requirements: z.array(z.string()).optional(),
  acceptanceCriteria: z.array(z.string()).optional(),
  affectedAreas: z.array(z.string()).optional(),
  notes: z.string().optional(),
});

/** Parse a GitHub issue into a structured, validated spec using the code model. */
export async function parseIssue(
  jobId: number,
  title: string,
  body: string,
  pro = false,
): Promise<IssueSpec> {
  const prompt = parseIssuePrompt(title, body);
  const raw = await callModelJson<unknown>(TaskType.PARSE, {
    system: prompt.system,
    user: prompt.user,
    jobId,
    pro,
  });
  const parsed = SpecSchema.parse(raw);
  return {
    title: parsed.title || title,
    summary: parsed.summary || title,
    requirements: parsed.requirements ?? [],
    acceptanceCriteria: parsed.acceptanceCriteria ?? [],
    affectedAreas: parsed.affectedAreas ?? [],
    notes: parsed.notes ?? "",
    // Preserve the raw issue so the implementer has the exact content/facts,
    // not just the distilled spec (otherwise specific details get lost).
    originalRequest: `# ${title}\n\n${body || "(no body provided)"}`,
  };
}
