import { z } from "zod";
import { callModelJson } from "../llm/client.js";
import { planPrompt } from "../llm/prompts.js";
import { TaskType, type IssueSpec } from "../types.js";

const PlanSchema = z.object({ steps: z.array(z.string()).optional() });

/** Turn a spec into an ordered list of implementation steps. */
export async function planSpec(jobId: number, spec: IssueSpec, pro = false): Promise<string[]> {
  const prompt = planPrompt(spec);
  const raw = await callModelJson<unknown>(TaskType.PLAN, {
    system: prompt.system,
    user: prompt.user,
    jobId,
    pro,
  });
  const parsed = PlanSchema.parse(raw);
  const steps = parsed.steps ?? [];
  return steps.length > 0 ? steps : ["Implement the requirements described in the spec."];
}
