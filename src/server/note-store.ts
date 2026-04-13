import {
  redisCommand,
  type AuthEnv,
  type PublicUser,
} from "../../functions/api/auth";

export type ProviderUsed = "featherless" | "ollama";

export type NoteJson = {
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
  provider_used: ProviderUsed;
};

export type NoteTranslation = {
  language: string;
  note: NoteJson;
  provider_used: ProviderUsed;
  createdAt: string;
  updatedAt: string;
};

export type ClinicNote = {
  id: string;
  userId: string;
  title: string;
  transcript: string;
  note: NoteJson;
  translations: Record<string, NoteTranslation>;
  createdAt: string;
  updatedAt: string;
};

const NOTE_PREFIX = "clinicscribe";
const MAX_NOTE_LIST_COUNT = 100;

const getUserNotesKey = (userId: string) => `${NOTE_PREFIX}:notes:${userId}`;
const getNoteKey = (noteId: string) => `${NOTE_PREFIX}:note:${noteId}`;

const asRecord = (value: unknown) =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

const isStringArray = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((item) => typeof item === "string");

export const normalizeLanguageKey = (language: string) =>
  language.trim().toLowerCase();

export const parseClinicNote = (value: unknown) => {
  if (typeof value !== "string") {
    return null;
  }

  try {
    const parsed = JSON.parse(value) as unknown;
    const note = asRecord(parsed);
    const noteJson = asRecord(note?.note);
    const soap = asRecord(noteJson?.soap);
    const extracted = asRecord(noteJson?.extracted);

    if (
      typeof note?.id === "string" &&
      typeof note.userId === "string" &&
      typeof note.title === "string" &&
      typeof note.transcript === "string" &&
      typeof note.createdAt === "string" &&
      typeof note.updatedAt === "string" &&
      noteJson &&
      typeof noteJson.language_detected === "string" &&
      (noteJson.provider_used === "featherless" ||
        noteJson.provider_used === "ollama") &&
      soap &&
      typeof soap.subjective === "string" &&
      typeof soap.objective === "string" &&
      typeof soap.assessment === "string" &&
      typeof soap.plan === "string" &&
      typeof noteJson.visit_summary === "string" &&
      typeof noteJson.discharge_instructions === "string" &&
      extracted &&
      isStringArray(extracted.symptoms) &&
      isStringArray(extracted.medications) &&
      isStringArray(extracted.follow_up_plan) &&
      isStringArray(extracted.red_flags) &&
      isStringArray(noteJson.uncertainties)
    ) {
      return {
        ...(note as Omit<ClinicNote, "translations">),
        translations:
          note.translations && typeof note.translations === "object"
            ? (note.translations as Record<string, NoteTranslation>)
            : {},
      } as ClinicNote;
    }
  } catch {
    return null;
  }

  return null;
};

const makeTitle = (note: NoteJson, transcript: string) => {
  const source = note.visit_summary.trim() || transcript.trim() || "Clinic note";
  const title = source.replace(/\s+/g, " ").slice(0, 90).trim();

  return title || "Clinic note";
};

export const toNoteResponse = (clinicNote: ClinicNote) => ({
  ...clinicNote.note,
  note_id: clinicNote.id,
  title: clinicNote.title,
  saved_at: clinicNote.createdAt,
  updated_at: clinicNote.updatedAt,
  translation_languages: Object.values(clinicNote.translations).map(
    (translation) => translation.language,
  ),
});

export const saveClinicNote = async (
  env: AuthEnv,
  user: PublicUser,
  transcript: string,
  note: NoteJson,
) => {
  const now = new Date().toISOString();
  const clinicNote: ClinicNote = {
    id: `note_${crypto.randomUUID()}`,
    userId: user.id,
    title: makeTitle(note, transcript),
    transcript,
    note,
    translations: {},
    createdAt: now,
    updatedAt: now,
  };

  await redisCommand(env, [
    "SET",
    getNoteKey(clinicNote.id),
    JSON.stringify(clinicNote),
  ]);
  await redisCommand(env, ["LPUSH", getUserNotesKey(user.id), clinicNote.id]);
  await redisCommand(env, [
    "LTRIM",
    getUserNotesKey(user.id),
    0,
    MAX_NOTE_LIST_COUNT - 1,
  ]);

  return clinicNote;
};

export const saveClinicNoteRecord = async (env: AuthEnv, note: ClinicNote) => {
  const nextNote = {
    ...note,
    updatedAt: new Date().toISOString(),
  };

  await redisCommand(env, ["SET", getNoteKey(note.id), JSON.stringify(nextNote)]);

  return nextNote;
};

export const getClinicNote = async (
  env: AuthEnv,
  userId: string,
  noteId: string,
) => {
  const note = parseClinicNote(await redisCommand(env, ["GET", getNoteKey(noteId)]));

  if (!note || note.userId !== userId) {
    return null;
  }

  return note;
};

export const listClinicNotes = async (env: AuthEnv, userId: string) => {
  const ids = await redisCommand(env, [
    "LRANGE",
    getUserNotesKey(userId),
    0,
    MAX_NOTE_LIST_COUNT - 1,
  ]);

  if (!Array.isArray(ids) || ids.length === 0) {
    return [];
  }

  const noteIds = ids.filter((id): id is string => typeof id === "string");
  const values = await redisCommand(env, ["MGET", ...noteIds]);

  if (!Array.isArray(values)) {
    return [];
  }

  return values
    .map(parseClinicNote)
    .filter((note): note is ClinicNote => note !== null && note.userId === userId);
};

export const summarizeClinicNote = (note: ClinicNote) => ({
  id: note.id,
  title: note.title,
  createdAt: note.createdAt,
  updatedAt: note.updatedAt,
  language_detected: note.note.language_detected,
  provider_used: note.note.provider_used,
  translation_languages: Object.values(note.translations).map(
    (translation) => translation.language,
  ),
});
