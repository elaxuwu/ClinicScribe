import { requireAuthenticatedUser, type AuthEnv } from "./auth";
import {
  getClinicNote,
  normalizeLanguageKey,
  saveClinicNoteRecord,
  type NoteJson,
  type NoteTranslation,
  type ProviderUsed,
} from "../../src/server/note-store";

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
  details?: unknown;
  body_preview?: string;
};

const CHAT_COMPLETIONS_PATH = "/chat/completions";
const OLLAMA_CHAT_URL = "https://ollama.com/api/chat";
const NOTE_MAX_TOKENS = 4000;

const TRANSLATION_SYSTEM_PROMPT = `You translate clinical documentation for clinicians and patients.
Translate every user-facing value into the requested language.
Preserve the exact JSON schema, array structure, medical meaning, medication names, dosages, numbers, and clinical uncertainty.
Do not add facts not present in the original note.
Return valid JSON only.
Do not include reasoning, markdown, or commentary.
Start the response with { and end it with }.`;

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

const logError = (message: string, data?: Record<string, unknown>) => {
  console.error(`[translate-note] ${message}`, data ?? {});
};

const asRecord = (value: unknown) =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

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

const getUpstreamErrorDetails = (value: unknown) => {
  const response = asRecord(value);

  if (typeof response?.error === "string") {
    return response.error;
  }

  const error = asRecord(response?.error);

  return typeof error?.message === "string" ? error.message : value;
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

const createTranslationMessages = (
  note: NoteJson,
  language: string,
): ChatMessage[] => [
  { role: "system", content: TRANSLATION_SYSTEM_PROMPT },
  {
    role: "user",
    content: [
      `Translate this clinical note JSON into ${language}.`,
      "Return only the translated JSON object with the exact same schema.",
      "",
      JSON.stringify(note),
    ].join("\n"),
  },
];

const createFeatherlessCompletionBody = (
  model: string,
  messages: ChatMessage[],
) => ({
  model,
  temperature: 0,
  max_tokens: NOTE_MAX_TOKENS,
  messages,
});

const createOllamaChatBody = (model: string, messages: ChatMessage[]) => ({
  model,
  stream: false,
  options: {
    temperature: 0,
    num_predict: NOTE_MAX_TOKENS,
  },
  messages,
});

const translateWithFeatherless = async (
  env: Env,
  note: NoteJson,
  language: string,
) => {
  const apiKey = getRequiredEnv(env, "FEATHERLESS_API_KEY");
  const baseUrl = normalizeBaseUrl(getRequiredEnv(env, "FEATHERLESS_BASE_URL"));
  const model = getRequiredEnv(env, "FEATHERLESS_MODEL");
  const messages = createTranslationMessages(note, language);
  const upstreamJson = await fetchJson(
    "Featherless",
    `${baseUrl}${CHAT_COMPLETIONS_PATH}`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(createFeatherlessCompletionBody(model, messages)),
    },
  );
  const modelContent = getOpenAiChatContent(upstreamJson);

  if (!modelContent) {
    throw new ProviderRequestError(
      "Featherless response did not include translated note content.",
      {
        kind: "missing-content",
      },
    );
  }

  try {
    return normalizeNoteJson(parseModelJson(modelContent), "featherless");
  } catch (error) {
    throw new ProviderRequestError(
      "Featherless translated note could not be parsed as valid JSON.",
      {
        kind: "invalid-note-json",
        details: getErrorMessage(error),
        bodyPreview: modelContent.slice(0, 500),
      },
    );
  }
};

const translateWithOllama = async (
  env: Env,
  note: NoteJson,
  language: string,
) => {
  const apiKey = getRequiredEnv(env, "OLLAMA_API_KEY");
  const model = getRequiredEnv(env, "OLLAMA_MODEL");
  const messages = createTranslationMessages(note, language);
  const upstreamJson = await fetchJson(
    "Ollama Cloud",
    OLLAMA_CHAT_URL,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(createOllamaChatBody(model, messages)),
    },
  );
  const modelContent = getOllamaChatContent(upstreamJson);

  if (!modelContent) {
    throw new ProviderRequestError(
      "Ollama Cloud response did not include translated note content.",
      {
        kind: "missing-content",
      },
    );
  }

  try {
    return normalizeNoteJson(parseModelJson(modelContent), "ollama");
  } catch (error) {
    throw new ProviderRequestError(
      "Ollama Cloud translated note could not be parsed as valid JSON.",
      {
        kind: "invalid-note-json",
        details: getErrorMessage(error),
        bodyPreview: modelContent.slice(0, 500),
      },
    );
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
      details: error.details,
      body_preview: error.bodyPreview,
    };
  }

  return {
    provider,
    message: getErrorMessage(error),
  };
};

const translateWithFallback = async (
  env: Env,
  note: NoteJson,
  language: string,
) => {
  try {
    return await translateWithFeatherless(env, note, language);
  } catch (featherlessError) {
    const featherlessFailure = summarizeProviderFailure(
      "featherless",
      featherlessError,
    );

    logError("Featherless translation failure", featherlessFailure);

    try {
      return await translateWithOllama(env, note, language);
    } catch (ollamaError) {
      const ollamaFailure = summarizeProviderFailure("ollama", ollamaError);

      logError("Ollama Cloud translation failure", ollamaFailure);

      throw new ProviderRequestError(
        "Unable to translate note. Featherless primary and Ollama Cloud fallback both failed.",
        {
          kind: "http",
          details: [featherlessFailure, ollamaFailure],
        },
      );
    }
  }
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

  const record =
    body && typeof body === "object" ? (body as Record<string, unknown>) : {};
  const noteId = typeof record.noteId === "string" ? record.noteId.trim() : "";
  const language =
    typeof record.language === "string" ? record.language.trim() : "";
  const force = record.force === true;

  if (!noteId) {
    return jsonResponse({ error: "noteId is required." }, { status: 400 });
  }

  if (!language || language.length > 60) {
    return jsonResponse({ error: "language is required." }, { status: 400 });
  }

  const note = await getClinicNote(env, authResult.id, noteId);

  if (!note) {
    return jsonResponse({ error: "Saved note not found." }, { status: 404 });
  }

  const languageKey = normalizeLanguageKey(language);
  const cachedTranslation = note.translations[languageKey];

  if (cachedTranslation && !force) {
    return jsonResponse({
      note_id: note.id,
      title: note.title,
      language: cachedTranslation.language,
      cached: true,
      result: {
        ...cachedTranslation.note,
        note_id: note.id,
        title: note.title,
        saved_at: note.createdAt,
        updated_at: note.updatedAt,
        translation_languages: Object.values(note.translations).map(
          (translation) => translation.language,
        ),
      },
    });
  }

  try {
    const translatedNote = await translateWithFallback(env, note.note, language);
    const now = new Date().toISOString();
    const translation: NoteTranslation = {
      language,
      note: translatedNote,
      provider_used: translatedNote.provider_used,
      createdAt: cachedTranslation?.createdAt ?? now,
      updatedAt: now,
    };
    const savedNote = await saveClinicNoteRecord(env, {
      ...note,
      translations: {
        ...note.translations,
        [languageKey]: translation,
      },
    });

    return jsonResponse({
      note_id: savedNote.id,
      title: savedNote.title,
      language,
      cached: false,
      result: {
        ...translation.note,
        note_id: savedNote.id,
        title: savedNote.title,
        saved_at: savedNote.createdAt,
        updated_at: savedNote.updatedAt,
        translation_languages: Object.values(savedNote.translations).map(
          (savedTranslation) => savedTranslation.language,
        ),
      },
    });
  } catch (error) {
    if (error instanceof ProviderRequestError) {
      return jsonResponse(
        {
          error: error.message,
          details: error.details,
        },
        { status: 502 },
      );
    }

    return jsonResponse(
      { error: "Unable to translate note.", details: getErrorMessage(error) },
      { status: 500 },
    );
  }
};
