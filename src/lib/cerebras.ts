/**
 * Lightweight Cerebras API client (OpenAI-compatible endpoint).
 * Uses the Cerebras Cloud REST API for fast inference.
 */

import { CerebrasError } from "./cerebras-error.js";

export { CerebrasError } from "./cerebras-error.js";

export interface CerebrasMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface CerebrasCompletionOptions {
  model?: string;
  messages: CerebrasMessage[];
  temperature?: number;
  max_tokens?: number;
  json_mode?: boolean;
}

export interface CerebrasChoice {
  index: number;
  message: { role: string; content: string };
  finish_reason: string;
}

export interface CerebrasUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
}

export interface CerebrasResponse {
  id: string;
  object: string;
  created: number;
  model: string;
  choices: CerebrasChoice[];
  usage: CerebrasUsage;
}

const DEFAULT_MODEL = "llama-4-scout-17b-16e-instruct";
const BASE_URL = "https://api.cerebras.ai/v1";
const MAX_RETRIES = 2;
const RETRY_DELAY_MS = 1000;

function getApiKey(): string {
  const key = process.env["CEREBRAS_API_KEY"];
  if (!key) throw new CerebrasError("CEREBRAS_API_KEY not set in environment");
  return key;
}

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function chatCompletion(
  opts: CerebrasCompletionOptions,
): Promise<CerebrasResponse> {
  const apiKey = getApiKey();
  const body: Record<string, unknown> = {
    model: opts.model || DEFAULT_MODEL,
    messages: opts.messages,
  };
  if (opts.temperature !== undefined) body.temperature = opts.temperature;
  if (opts.max_tokens !== undefined) body.max_tokens = opts.max_tokens;
  if (opts.json_mode) body.response_format = { type: "json_object" };

  let lastError: Error | null = null;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const res = await fetch(`${BASE_URL}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify(body),
      });

      if (!res.ok) {
        const text = await res.text();
        let errMsg = `Cerebras API error ${res.status}: ${text}`;
        let code: string | undefined;
        try {
          const parsed = JSON.parse(text);
          if (parsed.error?.message) errMsg = parsed.error.message;
          code = parsed.error?.code;
        } catch {}

        // Don't retry 4xx (except 429)
        if (res.status !== 429 && res.status < 500) {
          throw new CerebrasError(errMsg, res.status, code);
        }
        lastError = new CerebrasError(errMsg, res.status, code);
      } else {
        return (await res.json()) as CerebrasResponse;
      }
    } catch (e) {
      if (e instanceof CerebrasError && e.status && e.status < 500 && e.status !== 429) throw e;
      lastError = e instanceof Error ? e : new Error(String(e));
    }

    if (attempt < MAX_RETRIES) {
      await sleep(RETRY_DELAY_MS * (attempt + 1));
    }
  }

  throw lastError || new CerebrasError("Cerebras API request failed after retries");
}

/** Convenience: single prompt → string response */
export async function prompt(
  systemPrompt: string,
  userPrompt: string,
  opts?: { model?: string; temperature?: number; max_tokens?: number; json_mode?: boolean },
): Promise<string> {
  const res = await chatCompletion({
    model: opts?.model,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt },
    ],
    temperature: opts?.temperature,
    max_tokens: opts?.max_tokens,
    json_mode: opts?.json_mode,
  });
  return res.choices[0]?.message.content ?? "";
}

/** Convenience: prompt expecting JSON → parsed object */
export async function promptJson<T = unknown>(
  systemPrompt: string,
  userPrompt: string,
  opts?: { model?: string; temperature?: number; max_tokens?: number },
): Promise<T> {
  const raw = await prompt(systemPrompt, userPrompt, { ...opts, json_mode: true });
  return JSON.parse(raw) as T;
}
