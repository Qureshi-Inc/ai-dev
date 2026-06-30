import { config } from "../config.js";
import { extractJson } from "../llm/client.js";
import { logger } from "../utils/logger.js";

interface PhaseEntry {
  title: string;
  description: string;
}

interface PhasePlanOutput {
  phases: PhaseEntry[];
}

/**
 * Break a large project issue into sequential build phases using Bedrock (Claude Opus) directly.
 * Each phase is independently plannable and produces 4-10 tasks when expanded.
 */
export async function generatePhases(params: {
  issueTitle: string;
  issueBody: string;
  repoContext: string;
  maxPhases?: number;
}): Promise<Array<{ title: string; description: string }>> {
  const maxPhases = params.maxPhases ?? 6;

  const prompt = [
    "You are an Epic Planner. You break a large project into sequential BUILD PHASES.",
    "",
    "## Rules",
    "- Each phase is independently plannable and executable",
    "- Phases build on each other: Phase 2 assumes Phase 1 is merged into the codebase",
    "- Each phase should produce 4-10 tasks when expanded by a task planner",
    `- Maximum ${maxPhases} phases`,
    "- Each phase description should be 1-3 paragraphs — specific enough to be a standalone issue",
    "- Do NOT include investigation/research/analysis phases — EVERY phase must produce code",
    "- Order: foundational infrastructure first, features next, integrations/polish last",
    "- Each phase title should be short and action-oriented (e.g., 'Build the API layer')",
    "",
    "## Issue",
    `### ${params.issueTitle}`,
    "",
    params.issueBody,
    "",
    "## Repository Context",
    params.repoContext,
    "",
    "Break this into sequential build phases. Output ONLY the JSON.",
  ].join("\n");

  logger.info("epic planner: generating phases via Bedrock (Claude Opus)");

  const { AnthropicBedrock } = await import("@anthropic-ai/bedrock-sdk");

  const client = new AnthropicBedrock({
    awsRegion: process.env.AWS_REGION || "us-east-1",
  });

  const response = await client.messages.create({
    model: "us.anthropic.claude-opus-4-6-v1",
    max_tokens: 8000,
    messages: [
      { role: "user", content: prompt },
    ],
    system: 'You are an Epic Planner AI. Respond with ONLY a valid JSON object matching: { "phases": [{ "title": "...", "description": "..." }] }. No prose, no explanation, no code fences.',
  });

  const text = response.content
    .filter((block) => block.type === "text")
    .map((block) => (block as unknown as { text: string }).text)
    .join("");

  if (!text) {
    throw new Error("Epic planner: Bedrock returned empty response");
  }

  logger.info({ model: "claude-opus-4-6", chars: text.length }, "epic planner: Bedrock response received");

  const parsed = extractJson<PhasePlanOutput>(text);

  if (!parsed || !Array.isArray(parsed.phases) || parsed.phases.length === 0) {
    throw new Error("Epic planner: invalid response (no phases array)");
  }

  // Validate and clamp
  const validated = parsed.phases
    .slice(0, maxPhases)
    .map((p, i) => ({
      title: p.title || `Phase ${i + 1}`,
      description: p.description || "",
    }))
    .filter((p) => p.title && p.description);

  if (validated.length === 0) {
    throw new Error("Epic planner: all phases were empty after validation");
  }

  logger.info({ count: validated.length }, "epic planner: generated phases");
  return validated;
}
