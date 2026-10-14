/**
 * Nemotron 3 Super on Nebius Token Factory: it reads TRANSCRIPT TEXT (never audio) and PROPOSES — promises
 * and asks with verbatim quotes, search terms, a reply draft. Code decides what is shown (gates.ts).
 *
 * Super is a reasoning model: with a small `max_tokens` it can spend the whole budget thinking and return no
 * answer, so every call leaves generous room, asks for low reasoning effort, and reads `content` only. An
 * empty or non-JSON answer is an error that the UI shows as such — never a fabricated result.
 * Super's card does not list Hindi among its languages; the quote and field gates exist so that its mistakes
 * are dropped instead of displayed.
 */

import type { TokenFactoryConfig } from "./nebius/config";
import type { ProposedItem, Segment } from "./gates";

export interface TfCall<T> {
  value: T | null;
  error: string | null;
  requestId: string | null;
  model: string;
  durationMs: number;
}

interface ChatCompletion {
  id?: string;
  choices?: Array<{ finish_reason?: string; message?: { content?: string | null } }>;
}

export const TF_MAX_TOKENS = 6144;

export async function chatJson<T>(
  tf: TokenFactoryConfig,
  opts: { name: string; system: string; user: string; schema: object; maxTokens?: number },
  fetchImpl: typeof fetch = fetch,
): Promise<TfCall<T>> {
  const started = Date.now();
  const done = (patch: Partial<TfCall<T>>): TfCall<T> => ({
    value: null,
    error: null,
    requestId: null,
    model: tf.model,
    durationMs: Date.now() - started,
    ...patch,
  });
  let res: Response;
  try {
    res = await fetchImpl(`${tf.baseUrl}/chat/completions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${tf.apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: tf.model,
        messages: [
          { role: "system", content: opts.system },
          // The docs advise giving the schema in the prompt as well as in response_format.
          { role: "user", content: `${opts.user}\n\nAnswer with JSON that follows this schema exactly:\n${JSON.stringify(opts.schema)}` },
        ],
        response_format: { type: "json_schema", json_schema: { name: opts.name, strict: true, schema: opts.schema } },
        max_tokens: opts.maxTokens ?? TF_MAX_TOKENS,
        temperature: 0,
        reasoning_effort: "low",
      }),
      signal: AbortSignal.timeout(120_000),
    });
  } catch (error) {
    return done({ error: `Token Factory request failed: ${error instanceof Error ? error.message : String(error)}` });
  }
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    return done({ error: `Token Factory returned ${res.status}${text ? `: ${text.slice(0, 300)}` : ""}` });
  }
  let body: ChatCompletion;
  try {
    body = (await res.json()) as ChatCompletion;
  } catch {
    return done({ error: "Token Factory returned a response that is not JSON." });
  }
  const requestId = body.id ?? res.headers.get("x-request-id");
  const content = (body.choices?.[0]?.message?.content ?? "").replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
  if (!content) {
    return done({ requestId, error: `Token Factory returned no answer (finish_reason ${body.choices?.[0]?.finish_reason ?? "unknown"}).` });
  }
  try {
    return done({ requestId, value: JSON.parse(content) as T });
  } catch {
    return done({ requestId, error: "Token Factory's answer was not valid JSON." });
  }
}

// ---------------------------------------------------------------- extraction

const NULLABLE_STRING = { type: ["string", "null"] };
const NULLABLE_INT = { type: ["integer", "null"] };

export const EXTRACTION_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    items: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          kind: { type: "string", enum: ["money", "call", "visit", "health", "other"] },
          who: { type: "string" },
          what_en: { type: "string" },
          quote: { type: "string" },
          segment: { type: "integer" },
          amount_inr: NULLABLE_INT,
          when: {
            type: "object",
            additionalProperties: false,
            properties: {
              type: { type: "string", enum: ["weekday", "date", "relative_days", "none"] },
              weekday: {
                type: ["string", "null"],
                enum: ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday", null],
              },
              qualifier: { type: ["string", "null"], enum: ["before", "on", "next", "this", null] },
              days: NULLABLE_INT,
              day_of_month: NULLABLE_INT,
              raw: NULLABLE_STRING,
            },
            required: ["type", "weekday", "qualifier", "days", "day_of_month", "raw"],
          },
          resolves: NULLABLE_STRING,
        },
        required: ["kind", "who", "what_en", "quote", "segment", "amount_inr", "when", "resolves"],
      },
    },
    glosses: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: { segment: { type: "integer" }, en: { type: "string" } },
        required: ["segment", "en"],
      },
    },
  },
  required: ["items", "glosses"],
} as const;

export interface Extraction {
  items: ProposedItem[];
  glosses: Array<{ segment: number; en: string }>;
}

export const EXTRACTION_SYSTEM = [
  "You read the Hindi transcript of one family voice note, split into numbered segments, and list what it asks",
  "for or promises: money to send, calls to make, visits, health mentions, other tasks. Rules:",
  "- quote: copy the exact words from ONE segment, character for character, in Devanagari as written there. Never",
  "  paraphrase, translate, fix spelling or add punctuation. Quote the clause that carries the ask, and when the",
  "  ask has a day, date or amount, the quote MUST include those words too (e.g. from the day name to the verb).",
  "- segment: the number of the segment the quote is copied from.",
  "- amount_inr: only when the quote itself states an amount of money; otherwise null.",
  "- when: weekday = the day name in the quote as an English lower-case name (sunday...saturday), and qualifier is",
  "  the English word: before (for \"<day> से पहले\"), on (\"<day> को\" / \"<day> तक\"), next (\"अगले <day>\"), this (\"इस <day>\");",
  "  relative_days = कल (1) or परसों (2) when they mean the future; date = \"<n> तारीख\" with day_of_month n;",
  "  otherwise type none. raw = the time words exactly as in the quote, or null.",
  "- who: the person the item is about or from (use the sender label given for the speaker).",
  "- what_en: a short neutral English description. Health mentions (pain, a doctor, medicine) are items of kind",
  "  health: describe what was said, never diagnose.",
  "- resolves: if the note says an earlier open item is done (for example money received), that item's id; else null.",
  "- Do not invent items. Small talk and past events are not items. An empty list is a valid answer.",
  "- glosses: an English machine translation of every segment, one per segment number.",
].join("\n");

export function extractionPrompt(args: {
  senderLabel: string;
  noteDate: string;
  segments: Segment[];
  openItems: Array<{ id: string; kind: string; what_en: string; amount_inr: number | null }>;
}): string {
  return JSON.stringify(
    {
      sender_label: args.senderLabel,
      note_date: args.noteDate,
      open_items: args.openItems,
      segments: args.segments.map((s) => ({ segment: s.i, text: s.text })),
    },
    null,
    1,
  );
}

export async function extract(
  tf: TokenFactoryConfig,
  args: Parameters<typeof extractionPrompt>[0],
  fetchImpl: typeof fetch = fetch,
): Promise<TfCall<Extraction>> {
  return chatJson<Extraction>(
    tf,
    { name: "hearth_memory", system: EXTRACTION_SYSTEM, user: extractionPrompt(args), schema: EXTRACTION_SCHEMA },
    fetchImpl,
  );
}

// ---------------------------------------------------------------- search expansion

export const EXPANSION_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    terms_hi: { type: "array", items: { type: "string" } },
    terms_en: { type: "array", items: { type: "string" } },
  },
  required: ["terms_hi", "terms_en"],
} as const;

export interface Expansion {
  terms_hi: string[];
  terms_en: string[];
}

export async function expandQuery(tf: TokenFactoryConfig, query: string, fetchImpl: typeof fetch = fetch): Promise<TfCall<Expansion>> {
  return chatJson<Expansion>(
    tf,
    {
      name: "hearth_search",
      system:
        "A person searches the Hindi voice notes their family sent them. Turn the query into single search words: " +
        "Hindi words in Devanagari as a parent would SAY them in a voice note (include common inflected forms, e.g. " +
        "घुटना, घुटने) and English words. At most 8 of each. Words only, no sentences.",
      user: `Query: ${query}`,
      schema: EXPANSION_SCHEMA,
      maxTokens: 2048,
    },
    fetchImpl,
  );
}

// ---------------------------------------------------------------- reply draft

export const DRAFT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: { hi: { type: "string" }, en: { type: "string" } },
  required: ["hi", "en"],
} as const;

export interface Draft {
  hi: string;
  en: string;
}

export async function draftReply(
  tf: TokenFactoryConfig,
  items: Array<{ what_en: string; quote: string; due_label: string }>,
  recipient: string,
  fetchImpl: typeof fetch = fetch,
): Promise<TfCall<Draft>> {
  return chatJson<Draft>(
    tf,
    {
      name: "hearth_draft",
      system:
        "Draft a short, warm reply (2-3 sentences) in simple Hindi (Devanagari) from an adult child to a parent, " +
        "acknowledging the listed requests and saying when each will be done. Then give an English gloss. " +
        "No promises beyond the listed items; no medical advice.",
      user: JSON.stringify({ recipient, items }),
      schema: DRAFT_SCHEMA,
      maxTokens: 3072,
    },
    fetchImpl,
  );
}
