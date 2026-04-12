interface Env {
  FEATHERLESS_API_KEY?: string;
  FEATHERLESS_BASE_URL?: string;
  FEATHERLESS_PROXY_BASE_URL?: string;
  FEATHERLESS_PROXY_SHARED_SECRET?: string;
}

type NoteJson = {
  language_detected: string;
  soap: {
    subjective: string;
    objective: string;
    assessment: string;
    plan: string;
  };
  visit_summary: string;
  extracted: {
    symptoms: string[];
    medications: string[];
    follow_up_plan: string[];
    red_flags: string[];
  };
  discharge_instructions: string;
  uncertainties: string[];
};

type FeatherlessChatResponse = {
  choices?: Array<{
    message?: {
      content?: string;
    };
  }>;
  error?: {
    message?: string;
  };
};

const NOTE_MODEL = "Qwen/Qwen3.5-27B";
const DEFAULT_FEATHERLESS_BASE_URL = "https://api.featherless.ai/v1";
const CHAT_COMPLETIONS_PATH = "/chat/completions";
const MODELS_PATH = "/models";
const MAX_TRANSCRIPT_CHARS = 30000;
const MAX_FEATHERLESS_ATTEMPTS = 3;

const SYSTEM_PROMPT = `You are a multilingual medical scribe for clinics.
Faithfully transform transcript text into structured clinical documentation.
Support Vietnamese, English, and mixed-language clinic conversations.
Do not invent facts not present in the transcript.
Separate uncertain information clearly in the uncertainties array.
Preserve medication names exactly when possible.
Produce patient-friendly discharge instructions in simpler language.
Output valid JSON only.

The JSON schema must be exactly:
{
  "language_detected": "string",
  "soap": {
    "subjective": "string",
    "objective": "string",
    "assessment": "string",
    "plan": "string"
  },
  "visit_summary": "string",
  "extracted": {
    "symptoms": ["string"],
    "medications": ["string"],
    "follow_up_plan": ["string"],
    "red_flags": ["string"]
  },
  "discharge_instructions": "string",
  "uncertainties": ["string"]
}`;

const jsonHeaders = {
  "Content-Type": "application/json",
};

const jsonResponse = (body: unknown, init?: ResponseInit) =>
  new Response(JSON.stringify(body), {
    ...init,
    headers: {
      ...jsonHeaders,
      ...init?.headers,
    },
  });

const sleep = (ms: number) =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

const getFeatherlessBaseUrl = (env: Env) =>
  (env.FEATHERLESS_PROXY_BASE_URL ||
    env.FEATHERLESS_BASE_URL ||
    DEFAULT_FEATHERLESS_BASE_URL)
    .trim()
    .replace(/\/+$/, "");

const getErrorMessage = (error: unknown) =>
  error instanceof Error ? error.message : "Unknown error";

const logInfo = (message: string, data?: Record<string, unknown>) => {
  console.log(`[make-note] ${message}`, data ?? {});
};

const logError = (message: string, data?: Record<string, unknown>) => {
  console.error(`[make-note] ${message}`, data ?? {});
};

const fetchTextWithNetworkRetries = async (url: string, init: RequestInit) => {
  let lastError: unknown;

  for (let attempt = 1; attempt <= MAX_FEATHERLESS_ATTEMPTS; attempt += 1) {
    logInfo("Featherless request attempt", {
      endpoint: url,
      attempt,
      maxAttempts: MAX_FEATHERLESS_ATTEMPTS,
    });

    try {
      const response = await fetch(url, init);
      logInfo("Featherless response received", {
        endpoint: url,
        attempt,
        status: response.status,
      });

      const text = await response.text();
      return {
        ok: response.ok,
        status: response.status,
        text,
      };
    } catch (error) {
      lastError = error;
      logError("Featherless fetch/network error", {
        endpoint: url,
        attempt,
        message: getErrorMessage(error),
      });

      if (attempt < MAX_FEATHERLESS_ATTEMPTS) {
        await sleep(250 * 2 ** (attempt - 1));
      }
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new Error("Featherless request failed without a response.");
};

// Temporary runtime connectivity check when debugging Cloudflare reachability:
// fetch(`${getFeatherlessBaseUrl(env)}${MODELS_PATH}`, {
//   headers: { Authorization: `Bearer ${env.FEATHERLESS_API_KEY}` },
// });

const parseModelJson = (content: string): unknown => {
  const trimmed = content
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "");

  try {
    return JSON.parse(trimmed);
  } catch {
    const firstBrace = trimmed.indexOf("{");
    const lastBrace = trimmed.lastIndexOf("}");

    if (firstBrace === -1 || lastBrace === -1 || lastBrace <= firstBrace) {
      throw new Error("The model did not return a JSON object.");
    }

    return JSON.parse(trimmed.slice(firstBrace, lastBrace + 1));
  }
};

const toStringValue = (value: unknown) =>
  typeof value === "string" ? value : "";

const toStringArray = (value: unknown) =>
  Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];

const normalizeNoteJson = (value: unknown): NoteJson => {
  const source =
    value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  const soap =
    source.soap && typeof source.soap === "object"
      ? (source.soap as Record<string, unknown>)
      : {};
  const extracted =
    source.extracted && typeof source.extracted === "object"
      ? (source.extracted as Record<string, unknown>)
      : {};

  return {
    language_detected: toStringValue(source.language_detected),
    soap: {
      subjective: toStringValue(soap.subjective),
      objective: toStringValue(soap.objective),
      assessment: toStringValue(soap.assessment),
      plan: toStringValue(soap.plan),
    },
    visit_summary: toStringValue(source.visit_summary),
    extracted: {
      symptoms: toStringArray(extracted.symptoms),
      medications: toStringArray(extracted.medications),
      follow_up_plan: toStringArray(extracted.follow_up_plan),
      red_flags: toStringArray(extracted.red_flags),
    },
    discharge_instructions: toStringValue(source.discharge_instructions),
    uncertainties: toStringArray(source.uncertainties),
  };
};

export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  if (!env.FEATHERLESS_API_KEY) {
    return jsonResponse(
      { error: "Missing FEATHERLESS_API_KEY environment variable." },
      { status: 500 },
    );
  }

  let body: unknown;

  try {
    body = await request.json();
  } catch {
    return jsonResponse({ error: "Request body must be valid JSON." }, { status: 400 });
  }

  const transcript =
    body && typeof body === "object" && "transcript" in body
      ? (body as { transcript?: unknown }).transcript
      : undefined;

  if (typeof transcript !== "string") {
    return jsonResponse({ error: "transcript must be a string." }, { status: 400 });
  }

  const trimmedTranscript = transcript.trim();

  if (!trimmedTranscript) {
    return jsonResponse({ error: "transcript is required." }, { status: 400 });
  }

  if (trimmedTranscript.length > MAX_TRANSCRIPT_CHARS) {
    return jsonResponse(
      { error: `transcript must be ${MAX_TRANSCRIPT_CHARS} characters or fewer.` },
      { status: 413 },
    );
  }

  const featherlessBaseUrl = getFeatherlessBaseUrl(env);
  const featherlessChatUrl = `${featherlessBaseUrl}${CHAT_COMPLETIONS_PATH}`;
  const upstreamHeaders = new Headers({
    Authorization: `Bearer ${env.FEATHERLESS_API_KEY}`,
    "Content-Type": "application/json",
  });

  if (env.FEATHERLESS_PROXY_BASE_URL && env.FEATHERLESS_PROXY_SHARED_SECRET) {
    upstreamHeaders.set("X-Internal-Proxy-Key", env.FEATHERLESS_PROXY_SHARED_SECRET);
  }

  logInfo("Using Featherless endpoint", {
    endpoint: featherlessChatUrl,
    connectivityCheck: `${featherlessBaseUrl}${MODELS_PATH}`,
    usingProxy: Boolean(env.FEATHERLESS_PROXY_BASE_URL),
  });

  try {
    const upstreamResponse = await fetchTextWithNetworkRetries(featherlessChatUrl, {
      method: "POST",
      headers: upstreamHeaders,
      body: JSON.stringify({
        model: NOTE_MODEL,
        temperature: 0.1,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          {
            role: "user",
            content: `Create the clinical note JSON from this transcript:\n\n${trimmedTranscript}`,
          },
        ],
      }),
    });

    let upstreamJson: FeatherlessChatResponse;

    try {
      upstreamJson = JSON.parse(upstreamResponse.text) as FeatherlessChatResponse;
    } catch {
      logError("Featherless returned malformed JSON", {
        endpoint: featherlessChatUrl,
        status: upstreamResponse.status,
        bodyPreview: upstreamResponse.text.slice(0, 300),
      });

      return jsonResponse(
        {
          error: "Featherless returned a non-JSON response.",
          endpoint: featherlessChatUrl,
          status: upstreamResponse.status,
          details: upstreamResponse.text.slice(0, 500),
        },
        { status: 502 },
      );
    }

    if (!upstreamResponse.ok) {
      logError("Featherless returned non-2xx status", {
        endpoint: featherlessChatUrl,
        status: upstreamResponse.status,
        details: upstreamJson.error?.message ?? upstreamJson,
      });

      return jsonResponse(
        {
          error: "Failed to generate note with Featherless.",
          endpoint: featherlessChatUrl,
          status: upstreamResponse.status,
          details: upstreamJson.error?.message ?? upstreamJson,
        },
        { status: upstreamResponse.status },
      );
    }

    const modelContent = upstreamJson.choices?.[0]?.message?.content;

    if (!modelContent) {
      return jsonResponse(
        { error: "Featherless response did not include note content." },
        { status: 502 },
      );
    }

    try {
      const parsedNote = parseModelJson(modelContent);
      return jsonResponse(normalizeNoteJson(parsedNote));
    } catch (error) {
      return jsonResponse(
        {
          error: "The model response could not be parsed as valid JSON.",
          details: error instanceof Error ? error.message : "Unknown parse error",
          raw: modelContent.slice(0, 1000),
        },
        { status: 502 },
      );
    }
  } catch (error) {
    logError("Featherless request failed after retries", {
      endpoint: featherlessChatUrl,
      attempts: MAX_FEATHERLESS_ATTEMPTS,
      details: getErrorMessage(error),
    });

    return jsonResponse(
      {
        error: "Unable to reach Featherless chat completions endpoint.",
        endpoint: featherlessChatUrl,
        attempts: MAX_FEATHERLESS_ATTEMPTS,
        details: getErrorMessage(error),
      },
      { status: 502 },
    );
  }
};
