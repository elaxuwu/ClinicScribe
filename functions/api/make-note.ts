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

type FeatherlessEndpoint = {
  baseUrl: string;
  chatUrl: string;
  usingProxy: boolean;
};

const NOTE_MODEL = "Qwen/Qwen3-32B";
const DEFAULT_FEATHERLESS_BASE_URL = "https://api.featherless.ai/v1";
const CHAT_COMPLETIONS_PATH = "/chat/completions";
const MODELS_PATH = "/models";
const MAX_TRANSCRIPT_CHARS = 30000;
const MAX_FEATHERLESS_ATTEMPTS = 3;
const MAX_NOTE_COMPLETION_ATTEMPTS = 2;
const NOTE_MAX_TOKENS = 4000;

const SYSTEM_PROMPT = `You are a multilingual medical scribe for clinics.
Faithfully transform transcript text into structured clinical documentation.
Support Vietnamese, English, and mixed-language clinic conversations.
Do not invent facts not present in the transcript.
Separate uncertain information clearly in the uncertainties array.
Preserve medication names exactly when possible.
Produce patient-friendly discharge instructions in simpler language.
Output valid JSON only.
Do not include reasoning, chain-of-thought, markdown, or commentary.
Start the response with { and end it with }.

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

const normalizeBaseUrl = (url: string) => url.trim().replace(/\/+$/, "");

const getDirectFeatherlessBaseUrl = (env: Env) =>
  normalizeBaseUrl(env.FEATHERLESS_BASE_URL || DEFAULT_FEATHERLESS_BASE_URL);

const getFeatherlessEndpoints = (env: Env): FeatherlessEndpoint[] => {
  const directBaseUrl = getDirectFeatherlessBaseUrl(env);

  return [
    {
      baseUrl: directBaseUrl,
      chatUrl: `${directBaseUrl}${CHAT_COMPLETIONS_PATH}`,
      usingProxy: false,
    },
  ];
};

const createUpstreamHeaders = (env: Env, usingProxy: boolean) => {
  const headers = new Headers({
    Authorization: `Bearer ${env.FEATHERLESS_API_KEY}`,
    "Content-Type": "application/json",
  });

  if (usingProxy && env.FEATHERLESS_PROXY_SHARED_SECRET) {
    headers.set("X-Internal-Proxy-Key", env.FEATHERLESS_PROXY_SHARED_SECRET);
  }

  return headers;
};

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

const fetchJsonWithRetries = async (
  url: string,
  init: RequestInit,
): Promise<{
  ok: boolean;
  status: number;
  json: unknown;
  text: string;
}> => {
  let lastStatus = 0;
  let lastText = "";

  for (let attempt = 1; attempt <= MAX_FEATHERLESS_ATTEMPTS; attempt += 1) {
    const response = await fetchTextWithNetworkRetries(url, init);
    lastStatus = response.status;
    lastText = response.text;

    try {
      return {
        ok: response.ok,
        status: response.status,
        json: JSON.parse(response.text) as unknown,
        text: response.text,
      };
    } catch (error) {
      logError("Featherless returned malformed JSON", {
        endpoint: url,
        attempt,
        status: response.status,
        message: getErrorMessage(error),
        bodyPreview: response.text.slice(0, 300),
      });

      if (attempt < MAX_FEATHERLESS_ATTEMPTS) {
        await sleep(250 * 2 ** (attempt - 1));
      }
    }
  }

  throw new Error(
    `Malformed JSON from Featherless after ${MAX_FEATHERLESS_ATTEMPTS} attempts. Last status: ${lastStatus}. Preview: ${lastText.slice(0, 300)}`,
  );
};

// Temporary runtime connectivity check when debugging Cloudflare reachability:
// fetch(`${getDirectFeatherlessBaseUrl(env)}${MODELS_PATH}`, {
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

const asRecord = (value: unknown) =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

const getUpstreamErrorDetails = (value: unknown) => {
  const response = asRecord(value);
  const error = asRecord(response?.error);

  return typeof error?.message === "string" ? error.message : value;
};

const getTextFromContentPart = (value: unknown) => {
  if (typeof value === "string") {
    return value;
  }

  const part = asRecord(value);

  if (!part) {
    return null;
  }

  if (typeof part.text === "string") {
    return part.text;
  }

  const nestedText = asRecord(part.text);

  return typeof nestedText?.value === "string" ? nestedText.value : null;
};

const getFeatherlessResponseSummary = (value: unknown) => {
  const response = asRecord(value);
  const choices = response?.choices;
  const choice = Array.isArray(choices) ? asRecord(choices[0]) : null;
  const message = asRecord(choice?.message);
  const content = message?.content;
  const reasoning = message?.reasoning;
  const usage = asRecord(response?.usage);

  return {
    id: typeof response?.id === "string" ? response.id : undefined,
    model: typeof response?.model === "string" ? response.model : undefined,
    finish_reason:
      typeof choice?.finish_reason === "string" ? choice.finish_reason : undefined,
    content_type: Array.isArray(content) ? "array" : typeof content,
    content_length:
      typeof content === "string"
        ? content.length
        : Array.isArray(content)
          ? content.length
          : undefined,
    has_reasoning: typeof reasoning === "string" && reasoning.length > 0,
    reasoning_length: typeof reasoning === "string" ? reasoning.length : undefined,
    usage: usage ?? undefined,
  };
};

const getModelContent = (value: unknown) => {
  const response = asRecord(value);
  const choices = response?.choices;

  if (!Array.isArray(choices)) {
    return null;
  }

  const [firstChoice] = choices;
  const choice = asRecord(firstChoice);
  const message = asRecord(choice?.message);
  const content = message?.content;

  if (typeof content === "string") {
    return content.trim() ? content : null;
  }

  if (!Array.isArray(content)) {
    return null;
  }

  const textParts = content
    .map(getTextFromContentPart)
    .filter((part): part is string => typeof part === "string" && part.length > 0);

  return textParts.length > 0 ? textParts.join("\n") : null;
};

const createNoteCompletionBody = (trimmedTranscript: string) => ({
  model: NOTE_MODEL,
  temperature: 0,
  max_tokens: NOTE_MAX_TOKENS,
  messages: [
    { role: "system", content: SYSTEM_PROMPT },
    {
      role: "user",
      content: [
        "Create the clinical note JSON from this transcript.",
        "Return only the final JSON object. Do not include analysis or reasoning.",
        "",
        trimmedTranscript,
      ].join("\n"),
    },
  ],
});

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

  const featherlessEndpoints = getFeatherlessEndpoints(env);
  const primaryEndpoint = featherlessEndpoints[0];
  let lastAttemptedEndpoint = primaryEndpoint;
  let previousProxyFailure:
    | {
        endpoint: string;
        status?: number;
        details: unknown;
      }
    | undefined;

  logInfo("Using Featherless endpoint", {
    endpoint: primaryEndpoint.chatUrl,
    fallbackEndpoint: featherlessEndpoints[1]?.chatUrl,
    connectivityCheck: `${primaryEndpoint.baseUrl}${MODELS_PATH}`,
    usingProxy: primaryEndpoint.usingProxy,
  });

  try {
    let emptyResponseSummary: ReturnType<
      typeof getFeatherlessResponseSummary
    > | null = null;

    completionLoop: for (
      let completionAttempt = 1;
      completionAttempt <= MAX_NOTE_COMPLETION_ATTEMPTS;
      completionAttempt += 1
    ) {
      const requestBody = JSON.stringify(createNoteCompletionBody(trimmedTranscript));

      for (
        let endpointIndex = 0;
        endpointIndex < featherlessEndpoints.length;
        endpointIndex += 1
      ) {
        const endpoint = featherlessEndpoints[endpointIndex];
        const hasFallbackEndpoint = endpointIndex < featherlessEndpoints.length - 1;
        lastAttemptedEndpoint = endpoint;

        let upstreamResponse: Awaited<ReturnType<typeof fetchJsonWithRetries>>;

        try {
          upstreamResponse = await fetchJsonWithRetries(endpoint.chatUrl, {
            method: "POST",
            headers: createUpstreamHeaders(env, endpoint.usingProxy),
            body: requestBody,
          });
        } catch (error) {
          const details = getErrorMessage(error);

          if (endpoint.usingProxy) {
            previousProxyFailure = {
              endpoint: endpoint.chatUrl,
              details,
            };
          }

          logError("Featherless endpoint request failed", {
            endpoint: endpoint.chatUrl,
            completionAttempt,
            details,
            usingProxy: endpoint.usingProxy,
          });

          if (endpoint.usingProxy && hasFallbackEndpoint) {
            logInfo("Retrying Featherless request without proxy", {
              failedEndpoint: endpoint.chatUrl,
              fallbackEndpoint: featherlessEndpoints[endpointIndex + 1].chatUrl,
              completionAttempt,
            });
            continue;
          }

          throw error;
        }

        if (!upstreamResponse.ok) {
          const details = getUpstreamErrorDetails(upstreamResponse.json);

          if (endpoint.usingProxy) {
            previousProxyFailure = {
              endpoint: endpoint.chatUrl,
              status: upstreamResponse.status,
              details,
            };
          }

          logError("Featherless returned non-2xx status", {
            endpoint: endpoint.chatUrl,
            status: upstreamResponse.status,
            details,
            usingProxy: endpoint.usingProxy,
          });

          if (endpoint.usingProxy && hasFallbackEndpoint) {
            logInfo("Retrying Featherless request without proxy", {
              failedEndpoint: endpoint.chatUrl,
              fallbackEndpoint: featherlessEndpoints[endpointIndex + 1].chatUrl,
              completionAttempt,
            });
            continue;
          }

          return jsonResponse(
            {
              error: "Failed to generate note with Featherless.",
              endpoint: endpoint.chatUrl,
              status: upstreamResponse.status,
              details,
              previousProxyFailure,
            },
            { status: upstreamResponse.status },
          );
        }

        const modelContent = getModelContent(upstreamResponse.json);
        const responseSummary = getFeatherlessResponseSummary(upstreamResponse.json);

        if (!modelContent) {
          emptyResponseSummary = responseSummary;
          logError("Featherless response did not include final note content", {
            endpoint: endpoint.chatUrl,
            completionAttempt,
            maxCompletionAttempts: MAX_NOTE_COMPLETION_ATTEMPTS,
            response: responseSummary,
          });

          if (endpoint.usingProxy && hasFallbackEndpoint) {
            logInfo("Retrying empty Featherless response without proxy", {
              failedEndpoint: endpoint.chatUrl,
              fallbackEndpoint: featherlessEndpoints[endpointIndex + 1].chatUrl,
              completionAttempt,
            });
            continue;
          }

          if (completionAttempt < MAX_NOTE_COMPLETION_ATTEMPTS) {
            await sleep(250 * completionAttempt);
            continue completionLoop;
          }

          break completionLoop;
        }

        try {
          const parsedNote = parseModelJson(modelContent);
          return jsonResponse(normalizeNoteJson(parsedNote));
        } catch (error) {
          const details =
            error instanceof Error ? error.message : "Unknown parse error";

          logError("The model response could not be parsed as valid JSON", {
            endpoint: endpoint.chatUrl,
            completionAttempt,
            maxCompletionAttempts: MAX_NOTE_COMPLETION_ATTEMPTS,
            details,
            response: responseSummary,
            rawPreview: modelContent.slice(0, 300),
          });

          if (completionAttempt < MAX_NOTE_COMPLETION_ATTEMPTS) {
            await sleep(250 * completionAttempt);
            continue completionLoop;
          }

          return jsonResponse(
            {
              error: "The model response could not be parsed as valid JSON.",
              details,
              response: responseSummary,
              raw: modelContent.slice(0, 1000),
            },
            { status: 502 },
          );
        }
      }
    }

    return jsonResponse(
      {
        error: "Featherless did not return final note JSON.",
        details:
          "The model stopped before producing message content. Try again, or use a non-reasoning note model if this repeats.",
        response: emptyResponseSummary,
      },
      { status: 502 },
    );
  } catch (error) {
    logError("Featherless request failed after retries", {
      endpoint: lastAttemptedEndpoint.chatUrl,
      attempts: MAX_FEATHERLESS_ATTEMPTS,
      details: getErrorMessage(error),
      previousProxyFailure,
    });

    return jsonResponse(
      {
        error: "Unable to reach Featherless chat completions endpoint.",
        endpoint: lastAttemptedEndpoint.chatUrl,
        attempts: MAX_FEATHERLESS_ATTEMPTS,
        details: getErrorMessage(error),
        previousProxyFailure,
      },
      { status: 502 },
    );
  }
};
