import {
  redisCommand,
  type AuthEnv,
  type PublicUser,
} from "../../functions/api/auth";

export type ProviderUsed = "featherless" | "ollama";

export type NoteJson = {
  language_detected: string;
  patient: {
    name: string;
    age: number | null;
    gender: string;
    date_of_birth: string;
  };
  encounter: {
    visit_date: string;
    chief_complaint: string;
    diagnosis: string;
  };
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

export type NoteRecording = {
  id: string;
  name: string;
  type: string;
  size: number;
  dataUrl: string;
  transcript: string;
  createdAt: string;
};

export type ClinicNote = {
  id: string;
  userId: string;
  title: string;
  transcript: string;
  note: NoteJson;
  recordings: NoteRecording[];
  translations: Record<string, NoteTranslation>;
  pinned: boolean;
  pinnedAt?: string;
  createdAt: string;
  updatedAt: string;
};

const NOTE_PREFIX = "clinicscribe";
const MAX_NOTE_LIST_COUNT = 100;
const MAX_NOTE_RECORDING_COUNT = 10;
const PENDING_RECORDING_TTL_SECONDS = 60 * 60 * 24;

const getUserNotesKey = (userId: string) => `${NOTE_PREFIX}:notes:${userId}`;
const getNoteKey = (noteId: string) => `${NOTE_PREFIX}:note:${noteId}`;
const getPendingRecordingKey = (recordingId: string) =>
  `${NOTE_PREFIX}:pending-recording:${recordingId}`;

const asRecord = (value: unknown) =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

const isStringArray = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((item) => typeof item === "string");

const base64Encode = (bytes: Uint8Array) => {
  let binary = "";

  bytes.forEach((byte) => {
    binary += String.fromCharCode(byte);
  });

  return btoa(binary);
};

const fileToDataUrl = async (file: File) => {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const type = file.type || "application/octet-stream";

  return `data:${type};base64,${base64Encode(bytes)}`;
};

const parseNoteRecording = (value: unknown) => {
  const recording = asRecord(value);

  if (
    typeof recording?.id === "string" &&
    typeof recording.name === "string" &&
    typeof recording.type === "string" &&
    typeof recording.size === "number" &&
    typeof recording.dataUrl === "string" &&
    typeof recording.transcript === "string" &&
    typeof recording.createdAt === "string"
  ) {
    return recording as NoteRecording;
  }

  return null;
};

const parsePendingRecording = (value: unknown) => {
  if (typeof value !== "string") {
    return null;
  }

  try {
    const parsed = JSON.parse(value) as unknown;
    const recording = parseNoteRecording(parsed);
    const record = asRecord(parsed);

    if (recording && typeof record?.userId === "string") {
      return {
        ...recording,
        userId: record.userId,
      };
    }
  } catch {
    return null;
  }

  return null;
};

const normalizeNoteRecordings = (value: unknown) =>
  Array.isArray(value)
    ? value
        .map(parseNoteRecording)
        .filter((recording): recording is NoteRecording => recording !== null)
        .slice(0, MAX_NOTE_RECORDING_COUNT)
    : [];

export const normalizeLanguageKey = (language: string) =>
  language.trim().toLowerCase();

const getStringValue = (value: unknown) =>
  typeof value === "string" ? value : "";

const getAgeValue = (value: unknown) => {
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

const normalizePatientMetadata = (value: unknown): NoteJson["patient"] => {
  const patient = asRecord(value) ?? {};

  return {
    name: getStringValue(patient.name),
    age: getAgeValue(patient.age),
    gender: getStringValue(patient.gender),
    date_of_birth: getStringValue(patient.date_of_birth),
  };
};

const normalizeEncounterMetadata = (value: unknown): NoteJson["encounter"] => {
  const encounter = asRecord(value) ?? {};

  return {
    visit_date: getStringValue(encounter.visit_date),
    chief_complaint: getStringValue(encounter.chief_complaint),
    diagnosis: getStringValue(encounter.diagnosis),
  };
};

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
      const normalizedNoteJson = {
        ...(noteJson as NoteJson),
        patient: normalizePatientMetadata(noteJson.patient),
        encounter: normalizeEncounterMetadata(noteJson.encounter),
      };

      return {
        ...(note as Omit<ClinicNote, "note" | "translations">),
        note: normalizedNoteJson,
        recordings: normalizeNoteRecordings(note.recordings),
        pinned: note.pinned === true,
        pinnedAt: typeof note.pinnedAt === "string" ? note.pinnedAt : undefined,
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
  const title = source.replace(/\s+/g, " ").trim();

  return title || "Clinic note";
};

export const toNoteResponse = (clinicNote: ClinicNote) => ({
  ...clinicNote.note,
  note_id: clinicNote.id,
  title: clinicNote.title,
  saved_at: clinicNote.createdAt,
  updated_at: clinicNote.updatedAt,
  recordings: clinicNote.recordings,
  pinned: clinicNote.pinned,
  pinned_at: clinicNote.pinnedAt,
  translation_languages: Object.values(clinicNote.translations).map(
    (translation) => translation.language,
  ),
});

export const saveClinicNote = async (
  env: AuthEnv,
  user: PublicUser,
  transcript: string,
  note: NoteJson,
  recordings: NoteRecording[] = [],
) => {
  const now = new Date().toISOString();
  const clinicNote: ClinicNote = {
    id: `note_${crypto.randomUUID()}`,
    userId: user.id,
    title: makeTitle(note, transcript),
    transcript,
    note,
    recordings: recordings.slice(0, MAX_NOTE_RECORDING_COUNT),
    translations: {},
    pinned: false,
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

export const savePendingRecording = async (
  env: AuthEnv,
  userId: string,
  audio: File,
) => {
  const now = new Date().toISOString();
  const recording: NoteRecording = {
    id: `recording_${crypto.randomUUID()}`,
    name: audio.name || "clinic-recording.webm",
    type: audio.type || "audio/webm",
    size: audio.size,
    dataUrl: await fileToDataUrl(audio),
    transcript: "",
    createdAt: now,
  };

  await redisCommand(env, [
    "SET",
    getPendingRecordingKey(recording.id),
    JSON.stringify({
      ...recording,
      userId,
    }),
    "EX",
    PENDING_RECORDING_TTL_SECONDS,
  ]);

  return {
    id: recording.id,
    name: recording.name,
    type: recording.type,
    size: recording.size,
    createdAt: recording.createdAt,
  };
};

export const getPendingRecordingsForNote = async (
  env: AuthEnv,
  userId: string,
  references: Array<{ id: string; transcript: string }>,
) => {
  const recordings = await Promise.all(
    references.slice(0, MAX_NOTE_RECORDING_COUNT).map(async (reference) => {
      const pendingRecording = parsePendingRecording(
        await redisCommand(env, ["GET", getPendingRecordingKey(reference.id)]),
      );

      if (!pendingRecording || pendingRecording.userId !== userId) {
        return null;
      }

      return {
        id: pendingRecording.id,
        name: pendingRecording.name,
        type: pendingRecording.type,
        size: pendingRecording.size,
        dataUrl: pendingRecording.dataUrl,
        transcript: reference.transcript || pendingRecording.transcript,
        createdAt: pendingRecording.createdAt,
      };
    }),
  );

  return recordings.filter(
    (recording): recording is NoteRecording => recording !== null,
  );
};

export const deletePendingRecordings = async (
  env: AuthEnv,
  recordingIds: string[],
) => {
  await Promise.all(
    recordingIds.map((recordingId) =>
      redisCommand(env, ["DEL", getPendingRecordingKey(recordingId)]),
    ),
  );
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

export const deleteClinicNote = async (
  env: AuthEnv,
  userId: string,
  noteId: string,
) => {
  const note = await getClinicNote(env, userId, noteId);

  if (!note) {
    return false;
  }

  await redisCommand(env, ["DEL", getNoteKey(noteId)]);
  await redisCommand(env, ["LREM", getUserNotesKey(userId), 0, noteId]);

  return true;
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
  const values = await Promise.all(
    noteIds.map((noteId) => redisCommand(env, ["GET", getNoteKey(noteId)])),
  );

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
  recording_count: note.recordings.length,
  pinned: note.pinned,
  pinnedAt: note.pinnedAt,
  translation_languages: Object.values(note.translations).map(
    (translation) => translation.language,
  ),
});
