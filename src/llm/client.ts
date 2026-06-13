import OpenAI from "openai";
import { config } from "../config.js";
import { routeModel } from "../router/router.js";
import { logModelCall } from "../storage/modelLog.js";
import { logger } from "../utils/logger.js";
import { TaskType } from "../types.js";

const client = new OpenAI({
  baseURL: config.llm.baseUrl,
  apiKey: config.llm.apiKey,
  timeout: config.llm.timeoutMs,
  // JIT model loading can make the very first request slow; allow one transparent retry.
  maxRetries: 1,
});

export interface CallOptions {
  system: string;
  user: string;
  /** Request structured JSON output and parse it. */
  json?: boolean;
  jobId?: number | null;
  temperature?: number;
  maxTokens?: number;
  /** Routing context: attempt number (for escalation) and pro flag. */
  attempt?: number;
  pro?: boolean;
}

export interface CallResult {
  model: string;
  text: string;
  latencyMs: number;
}

/**
 * Extract a JSON object/array from a model response that may be wrapped in
 * markdown fences or surrounded by prose.
 */
export function extractJson<T = unknown>(text: string): T {
  const trimmed = text.trim();

  // Strip ```json ... ``` or ``` ... ``` fences if present.
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1].trim() : trimmed;

  try {
    return JSON.parse(candidate) as T;
  } catch {
    // Fall back to locating the first balanced { ... } or [ ... ].
    const start = candidate.search(/[[{]/);
    if (start !== -1) {
      const open = candidate[start];
      const close = open === "{" ? "}" : "]";
      let depth = 0;
      for (let i = start; i < candidate.length; i++) {
        if (candidate[i] === open) depth++;
        else if (candidate[i] === close) {
          depth--;
          if (depth === 0) {
            const slice = candidate.slice(start, i + 1);
            return JSON.parse(slice) as T;
          }
        }
      }
    }
    throw new Error("model response did not contain valid JSON");
  }
}

/** Invoke the model selected for `task`, logging the full call for observability. */
export async function callModel(task: TaskType, opts: CallOptions): Promise<CallResult> {
  const model = routeModel(task, { attempt: opts.attempt, pro: opts.pro });
  const startedAt = Date.now();

  logger.info(
    {
      task,
      model,
      jobId: opts.jobId ?? null,
      json: opts.json ?? false,
      attempt: opts.attempt ?? 0,
      pro: opts.pro ?? false,
    },
    "llm call -> dispatch",
  );
  logger.debug({ task, model, system: opts.system, user: opts.user }, "llm prompt");

  // Some LM Studio builds reject response_format=json_object (they only accept
  // json_schema or text), so we enforce JSON via the prompt + a robust extractor
  // rather than the OpenAI response_format field.
  const userContent = opts.json
    ? `${opts.user}\n\nIMPORTANT: Return ONLY a single valid JSON value. No markdown, no code fences, no commentary before or after.`
    : opts.user;

  const params: Record<string, unknown> = {
    model,
    temperature: opts.temperature ?? 0.1,
    max_tokens: opts.maxTokens ?? config.llm.maxOutputTokens,
    messages: [
      { role: "system", content: opts.system },
      { role: "user", content: userContent },
    ],
  };
  // LM Studio-specific: JIT auto-unload TTL so the idle model is evicted, keeping
  // only the model being used resident (the router switches models by id).
  if (config.llm.ttlSeconds > 0) params.ttl = config.llm.ttlSeconds;

  const completion = await client.chat.completions.create(
    params as unknown as OpenAI.Chat.ChatCompletionCreateParamsNonStreaming,
  );

  const latencyMs = Date.now() - startedAt;
  const text = completion.choices[0]?.message?.content ?? "";

  // Model-mismatch guard: LM Studio (esp. with JIT off) can silently serve the
  // currently-loaded model for any requested id. Warn loudly if the server
  // answered as a different model than we routed to. Don't throw (id formatting
  // can differ harmlessly).
  const served = completion.model ?? "";
  if (served && served.trim().toLowerCase() !== model.trim().toLowerCase()) {
    logger.warn(
      { task, requested: model, served, jobId: opts.jobId ?? null },
      "model mismatch: requested model differs from server response (is the model downloaded / JIT on?)",
    );
  }

  logModelCall({
    jobId: opts.jobId ?? null,
    taskType: task,
    model,
    prompt: `SYSTEM:\n${opts.system}\n\nUSER:\n${opts.user}`,
    response: text,
    latencyMs,
  });

  logger.info({ task, model, latencyMs, chars: text.length }, "llm call <- response");
  logger.debug({ task, model, response: text }, "llm response body");

  return { model, text, latencyMs };
}

/** Call the model and parse a JSON response of type T, retrying once on parse failure. */
export async function callModelJson<T>(task: TaskType, opts: CallOptions): Promise<T> {
  const first = await callModel(task, { ...opts, json: true });
  try {
    return extractJson<T>(first.text);
  } catch (err) {
    logger.warn(
      { task, jobId: opts.jobId ?? null, err: (err as Error).message },
      "json parse failed; retrying once",
    );
    const retry = await callModel(task, {
      ...opts,
      json: true,
      user: `${opts.user}\n\nYour previous response was NOT valid JSON. Respond again with ONLY the JSON value, no prose, no code fences.`,
    });
    return extractJson<T>(retry.text);
  }
}

/** Lightweight reachability probe against the LM Studio endpoint. */
export async function pingLmStudio(): Promise<string[]> {
  const models = await client.models.list();
  return models.data.map((m) => m.id);
}
