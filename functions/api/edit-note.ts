import { requireAuthenticatedUser, type AuthEnv } from "./auth";
import { type NoteJson, type ProviderUsed } from "../../src/server/note-store";

interface Env extends AuthEnv {
  FEATHERLESS_API_KEY?: string;
  FEATHERLESS_BASE_URL?: string;
  FEATHERLESS_MODEL?: string;
  OLLAMA_API_KEY?: string;
  OLLAMA_MODEL?: string;
}

type ChatMessage = {
  role: "system" | "user" | "assistant";
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
const NOTE_MAX_TOKENS = 4500;
const MAX_MESSAGE_CHARS = 5000;
const MAX_SELECTED_TEXT_CHARS = 8000;
const MAX_CHAT_HISTORY_MESSAGES = 12;

const EDIT_SYSTEM_PROMPT = `You are ClinicScribe AI, a friendly clinical note assistant for clinicians.
You can both chat about the note and edit the supplied clinical note JSON.
If the clinician asks a greeting, question, explanation, or other conversational request, answer naturally in assistant_message and return the note unchanged.
If the clinician asks for an edit, update the relevant part of the note and briefly explain what changed in assistant_message.
The clinician may ask you to edit any part of the note, including patient metadata, SOAP, extracted data, discharge instructions, visit summary, and title.
Treat direct user edits as clinician-provided information, but do not invent medical facts beyond the current note or the user's request.
If selected_text is provided and an edit is requested, focus the edit on that exact excerpt while keeping the whole note consistent.
Return the full note object, not a diff or patch.
Preserve arrays as arrays and preserve the same JSON schema.
Use empty strings for unknown text fields and null for unknown patient age.
Return valid JSON only.
Do not include markdown, reasoning, or commentary outside the JSON.
Start the response with { and end it with }.

Return exactly this top-level shape:
{
  "assistant_message": "natural reply to the clinician",
  "changed": false,
  "note": {
    "title": "string",
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
  }
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
  console.error(`[edit-note] ${message}`, data ?? {});
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

const truncateText = (value: string, maxLength: number) =>
  value.length > maxLength ? value.slice(0, maxLength) : value;

const normalizeNoteJson = (value: unknown, providerUsed: ProviderUsed): NoteJson => {
  const source = asRecord(value) ?? {};
  const soap = asRecord(source.soap) ?? {};
  const patient = asRecord(source.patient) ?? {};
  const encounter = asRecord(source.encounter) ?? {};
  const extracted = asRecord(source.extracted) ?? {};

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

const getComparableNotePayload = (
  value: unknown,
  providerUsed: ProviderUsed,
) => {
  const source = asRecord(value) ?? {};
  const { provider_used: _providerUsed, ...noteJson } = normalizeNoteJson(
    value,
    providerUsed,
  );

  return {
    title: toStringValue(source.title).trim(),
    ...noteJson,
  };
};

const hasNoteChanged = (
  sourceNote: Record<string, unknown>,
  modelNote: Record<string, unknown>,
  providerUsed: ProviderUsed,
) =>
  JSON.stringify(getComparableNotePayload(sourceNote, providerUsed)) !==
  JSON.stringify(getComparableNotePayload(modelNote, providerUsed));

const normalizeHistoryMessages = (value: unknown): ChatMessage[] =>
  Array.isArray(value)
    ? value
        .map((item) => {
          const record = asRecord(item);
          const role = record?.role === "assistant" ? "assistant" : "user";
          const content =
            typeof record?.content === "string"
              ? truncateText(record.content.trim(), MAX_MESSAGE_CHARS)
              : "";

          return content ? { role, content } : null;
        })
        .filter((item): item is ChatMessage => item !== null)
        .slice(-MAX_CHAT_HISTORY_MESSAGES)
    : [];

const createEditMessages = (
  note: Record<string, unknown>,
  message: string,
  selectedText: string,
  chatHistory: ChatMessage[],
): ChatMessage[] => [
  { role: "system", content: EDIT_SYSTEM_PROMPT },
  ...chatHistory,
  {
    role: "user",
    content: [
      "Work with this current clinical note JSON.",
      "Chat if the request is conversational. Edit only when the clinician asks for a note change.",
      "Return only the required JSON shape.",
      "",
      "current_note_json:",
      JSON.stringify(note),
      "",
      selectedText ? "selected_text:" : "",
      selectedText,
      "",
      "clinician_request:",
      message,
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

const extractEditResult = (
  modelContent: string,
  providerUsed: ProviderUsed,
  sourceNote: Record<string, unknown>,
) => {
  const parsed = asRecord(parseModelJson(modelContent));
  const modelNote = asRecord(parsed?.note);

  if (!parsed || !modelNote) {
    throw new Error("The model did not return an edited note object.");
  }

  const assistantMessage = toStringValue(parsed.assistant_message).trim();
  const normalizedNote = normalizeNoteJson(modelNote, providerUsed);
  const changed = hasNoteChanged(sourceNote, modelNote, providerUsed);
  const now = new Date().toISOString();

  return {
    message:
      assistantMessage ||
      (changed
        ? "Done. I updated the note."
        : "I'm here. Tell me what you'd like to review or change in this note."),
    changed,
    result: {
      ...normalizedNote,
      note_id: sourceNote.note_id,
      title: toStringValue(modelNote.title).trim() || sourceNote.title || "Clinic note",
      saved_at: sourceNote.saved_at,
      updated_at: now,
      recordings: sourceNote.recordings,
      pinned: sourceNote.pinned,
      pinned_at: sourceNote.pinned_at,
      translation_languages: toStringArray(sourceNote.translation_languages),
      chat_history: sourceNote.chat_history,
    },
  };
};

const editWithFeatherless = async (
  env: Env,
  messages: ChatMessage[],
  sourceNote: Record<string, unknown>,
) => {
  const apiKey = getRequiredEnv(env, "FEATHERLESS_API_KEY");
  const baseUrl = normalizeBaseUrl(getRequiredEnv(env, "FEATHERLESS_BASE_URL"));
  const model = getRequiredEnv(env, "FEATHERLESS_MODEL");
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
      "Featherless response did not include edited note content.",
      {
        kind: "missing-content",
      },
    );
  }

  try {
    return extractEditResult(modelContent, "featherless", sourceNote);
  } catch (error) {
    throw new ProviderRequestError(
      "Featherless edited note could not be parsed as valid JSON.",
      {
        kind: "invalid-note-json",
        details: getErrorMessage(error),
        bodyPreview: modelContent.slice(0, 500),
      },
    );
  }
};

const editWithOllama = async (
  env: Env,
  messages: ChatMessage[],
  sourceNote: Record<string, unknown>,
) => {
  const apiKey = getRequiredEnv(env, "OLLAMA_API_KEY");
  const model = getRequiredEnv(env, "OLLAMA_MODEL");
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
      "Ollama Cloud response did not include edited note content.",
      {
        kind: "missing-content",
      },
    );
  }

  try {
    return extractEditResult(modelContent, "ollama", sourceNote);
  } catch (error) {
    throw new ProviderRequestError(
      "Ollama Cloud edited note could not be parsed as valid JSON.",
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
    };
  }

  return {
    provider,
    message: getErrorMessage(error),
  };
};

const editWithFallback = async (
  env: Env,
  messages: ChatMessage[],
  sourceNote: Record<string, unknown>,
) => {
  try {
    return await editWithFeatherless(env, messages, sourceNote);
  } catch (featherlessError) {
    const featherlessFailure = summarizeProviderFailure(
      "featherless",
      featherlessError,
    );

    logError("Featherless note-edit failure", featherlessFailure);

    try {
      return await editWithOllama(env, messages, sourceNote);
    } catch (ollamaError) {
      const ollamaFailure = summarizeProviderFailure("ollama", ollamaError);

      logError("Ollama Cloud note-edit failure", ollamaFailure);

      throw new ProviderRequestError(
        "Unable to edit note. Featherless primary and Ollama Cloud fallback both failed.",
        {
          kind: "http",
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

  const record = asRecord(body) ?? {};
  const sourceNote = asRecord(record.note);
  const message =
    typeof record.message === "string"
      ? truncateText(record.message.trim(), MAX_MESSAGE_CHARS)
      : "";
  const selectedText =
    typeof record.selectedText === "string"
      ? truncateText(record.selectedText.trim(), MAX_SELECTED_TEXT_CHARS)
      : "";

  if (!sourceNote) {
    return jsonResponse({ error: "note is required." }, { status: 400 });
  }

  if (!message) {
    return jsonResponse({ error: "message is required." }, { status: 400 });
  }

  const chatHistory = normalizeHistoryMessages(record.chatHistory);
  const messages = createEditMessages(
    sourceNote,
    message,
    selectedText,
    chatHistory,
  );

  try {
    return jsonResponse(await editWithFallback(env, messages, sourceNote));
  } catch (error) {
    if (error instanceof ProviderRequestError) {
      return jsonResponse(
        {
          error: error.message,
        },
        { status: 502 },
      );
    }

    return jsonResponse(
      { error: "Unable to edit note.", details: getErrorMessage(error) },
      { status: 500 },
    );
  }
};
