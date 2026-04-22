import { requireAuthenticatedUser, type AuthEnv } from "./auth";
import {
  deletePendingRecordings,
  getPendingRecordingsForNote,
  saveClinicNote,
  toNoteResponse,
  type NoteJson,
  type NoteRecording,
  type ProviderUsed,
} from "../../src/server/note-store";

// Generates the first clinical note from a transcript, then saves the note
// envelope in Redis for the note vault.
interface Env extends AuthEnv {
  FEATHERLESS_API_KEY?: string;
  FEATHERLESS_BASE_URL?: string;
  FEATHERLESS_MODEL?: string;
  OLLAMA_API_KEY?: string;
  OLLAMA_MODEL?: string;
}

type ChatMessage = {
  role: "system" | "user";
  content: string;
};

type ProviderErrorKind =
  | "config"
  | "network"
  | "http"
  | "malformed-json"
  | "missing-content"
  | "invalid-note-json";

type ProviderFailure = {
  provider: ProviderUsed;
  message: string;
  kind?: ProviderErrorKind;
  status?: number;
};

const CHAT_COMPLETIONS_PATH = "/chat/completions";
const OLLAMA_CHAT_URL = "https://ollama.com/api/chat";
const MAX_TRANSCRIPT_CHARS = 30000;
const MAX_FEATHERLESS_ATTEMPTS = 3;
const MAX_NOTE_COMPLETION_ATTEMPTS = 2;
const NOTE_MAX_TOKENS = 4000;

// Keep this strict because the UI expects this exact JSON shape, not markdown.
const SYSTEM_PROMPT = `You are a multilingual medical scribe for clinics.
Faithfully transform transcript text into structured clinical documentation.
Support Vietnamese, English, and mixed-language clinic conversations.
Do not invent facts not present in the transcript.
Separate uncertain information clearly in the uncertainties array.
Preserve medication names exactly when possible.
Extract patient demographics only when they are stated or strongly implied.
Use empty strings for unknown text fields and null for unknown patient age.
Produce patient-friendly discharge instructions in simpler language.
Output valid JSON only.
Do not include reasoning, chain-of-thought, markdown, or commentary.
Start the response with { and end it with }.

The JSON schema must be exactly:
{
  "language_detected": "string",
  "patient": {
    "name": "string",
    "age": null,
    "gender": "string",
    "date_of_birth": "string"
  },
  "encounter": {
    "visit_date": "string",
    "chief_complaint": "string",
    "diagnosis": "string"
  },
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

class ProviderRequestError extends Error {
  kind: ProviderErrorKind;
  status?: number;
  details?: unknown;
  bodyPreview?: string;

  constructor(
    message: string,
    options: {
      kind: ProviderErrorKind;
      status?: number;
      details?: unknown;
      bodyPreview?: string;
    },
  ) {
    super(message);
    this.name = "ProviderRequestError";
    this.kind = options.kind;
    this.status = options.status;
    this.details = options.details;
    this.bodyPreview = options.bodyPreview;
  }
}

const jsonHeaders = {
  "Content-Type": "application/json",
  "Cache-Control": "no-store",
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

const getRequiredEnv = (env: Env, name: keyof Env) => {
  const value = env[name]?.trim();

  if (!value) {
    throw new ProviderRequestError(`Missing ${name} environment variable.`, {
      kind: "config",
    });
  }

  return value;
};

const getErrorMessage = (error: unknown) =>
  error instanceof Error ? error.message : "Unknown error";

const logInfo = (message: string, data?: Record<string, unknown>) => {
  console.log(`[make-note] ${message}`, data ?? {});
};

const logError = (message: string, data?: Record<string, unknown>) => {
  console.error(`[make-note] ${message}`, data ?? {});
};

const asRecord = (value: unknown) =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

const getUpstreamErrorDetails = (value: unknown) => {
  const response = asRecord(value);

  if (typeof response?.error === "string") {
    return response.error;
  }

  const error = asRecord(response?.error);

  return typeof error?.message === "string" ? error.message : value;
};

const safeJsonParse = (text: string) => {
  try {
    return {
      ok: true as const,
      json: JSON.parse(text) as unknown,
    };
  } catch (error) {
    return {
      ok: false as const,
      error,
    };
  }
};

const fetchText = async (
  providerName: string,
  url: string,
  init: RequestInit,
) => {
  try {
    const response = await fetch(url, init);
    const text = await response.text();

    return {
      ok: response.ok,
      status: response.status,
      text,
    };
  } catch (error) {
    throw new ProviderRequestError(
      `${providerName} network request failed.`,
      {
        kind: "network",
        details: getErrorMessage(error),
      },
    );
  }
};

const fetchJson = async (
  providerName: string,
  url: string,
  init: RequestInit,
) => {
  const response = await fetchText(providerName, url, init);
  const parsed = safeJsonParse(response.text);

  if (!response.ok) {
    throw new ProviderRequestError(
      `${providerName} returned HTTP ${response.status}.`,
      {
        kind: "http",
        status: response.status,
        details: parsed.ok
          ? getUpstreamErrorDetails(parsed.json)
          : response.text.slice(0, 500),
        bodyPreview: response.text.slice(0, 500),
      },
    );
  }

  if (!parsed.ok) {
    throw new ProviderRequestError(`${providerName} returned malformed JSON.`, {
      kind: "malformed-json",
      status: response.status,
      details: getErrorMessage(parsed.error),
      bodyPreview: response.text.slice(0, 500),
    });
  }

  return parsed.json;
};

const isTransientFeatherlessError = (error: unknown) => {
  if (!(error instanceof ProviderRequestError)) {
    return true;
  }

  if (
    error.kind === "network" ||
    error.kind === "malformed-json"
  ) {
    return true;
  }

  return (
    error.kind === "http" &&
    (error.status === 408 || error.status === 429 || (error.status ?? 0) >= 500)
  );
};

const fetchFeatherlessJsonWithRetries = async (
  url: string,
  init: RequestInit,
) => {
  // Featherless is the happy path, but a couple retries smooth over cold starts
  // and short provider hiccups.
  let lastError: unknown;

  for (let attempt = 1; attempt <= MAX_FEATHERLESS_ATTEMPTS; attempt += 1) {
    logInfo("Featherless request attempt", {
      endpoint: url,
      attempt,
      maxAttempts: MAX_FEATHERLESS_ATTEMPTS,
    });

    try {
      const json = await fetchJson("Featherless", url, init);

      logInfo("Featherless response received", {
        endpoint: url,
        attempt,
      });

      return json;
    } catch (error) {
      lastError = error;

      logError("Featherless request attempt failed", {
        endpoint: url,
        attempt,
        maxAttempts: MAX_FEATHERLESS_ATTEMPTS,
        message: getErrorMessage(error),
        kind: error instanceof ProviderRequestError ? error.kind : undefined,
        status: error instanceof ProviderRequestError ? error.status : undefined,
      });

      if (attempt < MAX_FEATHERLESS_ATTEMPTS && isTransientFeatherlessError(error)) {
        await sleep(250 * 2 ** (attempt - 1));
        continue;
      }

      throw error;
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new Error("Featherless request failed without a response.");
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

const getOpenAiChatContent = (value: unknown) => {
  const response = asRecord(value);
  const choices = response?.choices;

  if (!Array.isArray(choices)) {
    return null;
  }

  const choice = asRecord(choices[0]);
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

const getOllamaChatContent = (value: unknown) => {
  const response = asRecord(value);
  const message = asRecord(response?.message);
  const content = message?.content;

  return typeof content === "string" && content.trim() ? content : null;
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

const getOllamaResponseSummary = (value: unknown) => {
  const response = asRecord(value);
  const message = asRecord(response?.message);
  const content = message?.content;

  return {
    model: typeof response?.model === "string" ? response.model : undefined,
    done: typeof response?.done === "boolean" ? response.done : undefined,
    done_reason:
      typeof response?.done_reason === "string" ? response.done_reason : undefined,
    content_length: typeof content === "string" ? content.length : undefined,
  };
};

const parseModelJson = (content: string): unknown => {
  // Providers sometimes wrap JSON in fences; pull the object out, but still fail
  // if the final payload is not valid JSON.
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

const toAgeValue = (value: unknown) => {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === "string") {
    const parsedAge = Number.parseInt(value, 10);

    if (Number.isFinite(parsedAge)) {
      return parsedAge;
    }
  }

  return null;
};

const getRecordingReferences = (value: unknown) =>
  Array.isArray(value)
    ? value
        .map((item) => {
          const record = asRecord(item);
          const id = typeof record?.id === "string" ? record.id.trim() : "";

          if (!id) {
            return null;
          }

          return {
            id,
            transcript:
              typeof record?.transcript === "string" ? record.transcript : "",
          };
        })
        .filter(
          (reference): reference is { id: string; transcript: string } =>
            reference !== null,
        )
    : [];

const normalizeNoteJson = (value: unknown, providerUsed: ProviderUsed): NoteJson => {
  const source =
    value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  const soap =
    source.soap && typeof source.soap === "object"
      ? (source.soap as Record<string, unknown>)
      : {};
  const patient =
    source.patient && typeof source.patient === "object"
      ? (source.patient as Record<string, unknown>)
      : {};
  const encounter =
    source.encounter && typeof source.encounter === "object"
      ? (source.encounter as Record<string, unknown>)
      : {};
  const extracted =
    source.extracted && typeof source.extracted === "object"
      ? (source.extracted as Record<string, unknown>)
      : {};

  return {
    language_detected: toStringValue(source.language_detected),
    patient: {
      name: toStringValue(patient.name),
      age: toAgeValue(patient.age),
      gender: toStringValue(patient.gender),
      date_of_birth: toStringValue(patient.date_of_birth),
    },
    encounter: {
      visit_date: toStringValue(encounter.visit_date),
      chief_complaint: toStringValue(encounter.chief_complaint),
      diagnosis: toStringValue(encounter.diagnosis),
    },
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
    provider_used: providerUsed,
  };
};

const createMessages = (trimmedTranscript: string): ChatMessage[] => [
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
];

const createFeatherlessCompletionBody = (
  model: string,
  trimmedTranscript: string,
) => ({
  model,
  temperature: 0,
  max_tokens: NOTE_MAX_TOKENS,
  messages: createMessages(trimmedTranscript),
});

const createOllamaChatBody = (model: string, trimmedTranscript: string) => ({
  model,
  stream: false,
  options: {
    temperature: 0,
    num_predict: NOTE_MAX_TOKENS,
  },
  messages: createMessages(trimmedTranscript),
});

const wrapInvalidNoteJson = (
  providerName: string,
  error: unknown,
  modelContent: string,
) =>
  new ProviderRequestError(
    `${providerName} model response could not be parsed as valid note JSON.`,
    {
      kind: "invalid-note-json",
      details: getErrorMessage(error),
      bodyPreview: modelContent.slice(0, 500),
    },
  );

const shouldRetryNoteCompletion = (error: unknown) =>
  error instanceof ProviderRequestError &&
  (error.kind === "missing-content" || error.kind === "invalid-note-json");

const generateWithFeatherless = async (
  env: Env,
  trimmedTranscript: string,
): Promise<NoteJson> => {
  const apiKey = getRequiredEnv(env, "FEATHERLESS_API_KEY");
  const baseUrl = normalizeBaseUrl(getRequiredEnv(env, "FEATHERLESS_BASE_URL"));
  const model = getRequiredEnv(env, "FEATHERLESS_MODEL");
  const chatUrl = `${baseUrl}${CHAT_COMPLETIONS_PATH}`;
  let lastError: unknown;

  logInfo("Using Featherless primary provider", {
    endpoint: chatUrl,
    model,
  });

  for (
    let completionAttempt = 1;
    completionAttempt <= MAX_NOTE_COMPLETION_ATTEMPTS;
    completionAttempt += 1
  ) {
    try {
      const upstreamJson = await fetchFeatherlessJsonWithRetries(chatUrl, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(
          createFeatherlessCompletionBody(model, trimmedTranscript),
        ),
      });

      const modelContent = getOpenAiChatContent(upstreamJson);
      const responseSummary = getFeatherlessResponseSummary(upstreamJson);

      if (!modelContent) {
        throw new ProviderRequestError(
          "Featherless response did not include final note content.",
          {
            kind: "missing-content",
            details: responseSummary,
          },
        );
      }

      try {
        return normalizeNoteJson(parseModelJson(modelContent), "featherless");
      } catch (error) {
        throw wrapInvalidNoteJson("Featherless", error, modelContent);
      }
    } catch (error) {
      lastError = error;

      logError("Featherless note-generation attempt failed", {
        completionAttempt,
        maxCompletionAttempts: MAX_NOTE_COMPLETION_ATTEMPTS,
        message: getErrorMessage(error),
        kind: error instanceof ProviderRequestError ? error.kind : undefined,
        status: error instanceof ProviderRequestError ? error.status : undefined,
      });

      if (
        completionAttempt < MAX_NOTE_COMPLETION_ATTEMPTS &&
        shouldRetryNoteCompletion(error)
      ) {
        await sleep(250 * completionAttempt);
        continue;
      }

      throw error;
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new Error("Featherless failed without an error.");
};

const generateWithOllama = async (
  env: Env,
  trimmedTranscript: string,
): Promise<NoteJson> => {
  const apiKey = getRequiredEnv(env, "OLLAMA_API_KEY");
  const model = getRequiredEnv(env, "OLLAMA_MODEL");

  logInfo("Using Ollama Cloud fallback provider", {
    endpoint: OLLAMA_CHAT_URL,
    model,
  });

  const upstreamJson = await fetchJson(
    "Ollama Cloud",
    OLLAMA_CHAT_URL,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(createOllamaChatBody(model, trimmedTranscript)),
    },
  );

  const modelContent = getOllamaChatContent(upstreamJson);
  const responseSummary = getOllamaResponseSummary(upstreamJson);

  if (!modelContent) {
    throw new ProviderRequestError(
      "Ollama Cloud response did not include final note content.",
      {
        kind: "missing-content",
        details: responseSummary,
      },
    );
  }

  try {
    return normalizeNoteJson(parseModelJson(modelContent), "ollama");
  } catch (error) {
    throw wrapInvalidNoteJson("Ollama Cloud", error, modelContent);
  }
};

const summarizeProviderFailure = (
  provider: ProviderUsed,
  error: unknown,
): ProviderFailure => {
  if (error instanceof ProviderRequestError) {
    return {
      provider,
      message: error.message,
      kind: error.kind,
      status: error.status,
    };
  }

  return {
    provider,
    message: getErrorMessage(error),
  };
};

export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  const authResult = await requireAuthenticatedUser(request, env);

  if (authResult instanceof Response) {
    return authResult;
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

  const recordingReferences = getRecordingReferences(
    body && typeof body === "object"
      ? (body as Record<string, unknown>).recordings
      : undefined,
  );
  let recordings: NoteRecording[] = [];

  if (recordingReferences.length > 0) {
    try {
      recordings = await getPendingRecordingsForNote(
        env,
        authResult.id,
        recordingReferences,
      );
    } catch (error) {
      return jsonResponse(
        {
          error: "Unable to attach recorded audio to the note.",
          details: getErrorMessage(error),
        },
        { status: 500 },
      );
    }
  }

  let generatedNote: NoteJson;

  try {
    generatedNote = await generateWithFeatherless(env, trimmedTranscript);
  } catch (featherlessError) {
    const featherlessFailure = summarizeProviderFailure(
      "featherless",
      featherlessError,
    );

    logError("Featherless failure", featherlessFailure);
    logInfo("Activating Ollama Cloud fallback", {
      reason: featherlessFailure.message,
    });

    try {
      // Ollama is the fallback when the primary provider cannot finish this note.
      generatedNote = await generateWithOllama(env, trimmedTranscript);
    } catch (ollamaError) {
      const ollamaFailure = summarizeProviderFailure("ollama", ollamaError);

      logError("Ollama Cloud fallback failure", ollamaFailure);

      return jsonResponse(
        {
          error:
            "Unable to generate note. Featherless primary and Ollama Cloud fallback both failed.",
        },
        { status: 502 },
      );
    }
  }

  let savedNote: Awaited<ReturnType<typeof saveClinicNote>>;

  try {
    savedNote = await saveClinicNote(
      env,
      authResult,
      trimmedTranscript,
      generatedNote,
      recordings,
    );
  } catch (error) {
    logError("Redis note save failure", {
      message: getErrorMessage(error),
    });

    return jsonResponse(
      {
        error: "Unable to save generated note to the note vault.",
        details: getErrorMessage(error),
      },
      { status: 500 },
    );
  }

  if (recordings.length > 0) {
    try {
      await deletePendingRecordings(
        env,
        recordings.map((recording) => recording.id),
      );
    } catch (error) {
      logError("Pending recording cleanup failure", {
        message: getErrorMessage(error),
      });
    }
  }

  return jsonResponse(toNoteResponse(savedNote));
};
