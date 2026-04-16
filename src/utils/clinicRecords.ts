import { supabase } from "./supabase";

export type PatientDraft = {
  patientProfileId?: string;
  patientId: string;
  name: string;
  age: string;
  gender: string;
  visitDate: string;
  diagnosis: string;
};

export type EncounterSummary = {
  id: string;
  legacyNoteId?: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  patientProfileId?: string;
  patientId?: string;
  patientName: string;
  patientAge?: number;
  patientGender?: string;
  diagnosis?: string;
  visitDate?: string;
  languageDetected?: string;
  providerUsed?: string;
  recordingCount: number;
  translationLanguages: string[];
  pinned: boolean;
  pinnedAt?: string;
};

export type EncounterDetail = EncounterSummary & {
  transcript: string;
  result: Record<string, unknown>;
};

export type PatientProfile = {
  profileId: string;
  patientId?: string;
  name: string;
  age?: number;
  gender?: string;
  createdAt: string;
  updatedAt: string;
};

type CurrentSupabaseUser = {
  id: string;
};

type PatientRow = {
  id: string;
  name: string;
  name_key: string;
  patient_identifier: string | null;
  age: number | null;
  gender: string | null;
  created_at: string | null;
  updated_at: string | null;
};

type EncounterRow = {
  id: string;
  legacy_note_id: string | null;
  title: string | null;
  transcript: string | null;
  note_json: unknown;
  summary: string | null;
  diagnosis: string | null;
  visit_date: string | null;
  language_detected: string | null;
  provider_used: string | null;
  pinned: boolean | null;
  pinned_at: string | null;
  created_at: string | null;
  updated_at: string | null;
  patient?: unknown;
};

const UNKNOWN_PATIENT = "Unknown patient";

const asRecord = (value: unknown) =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

const asString = (value: unknown) =>
  typeof value === "string" ? value.trim() : "";

const asStringArray = (value: unknown) =>
  Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];

const getNestedRecord = (
  source: Record<string, unknown>,
  key: string,
): Record<string, unknown> => asRecord(source[key]) ?? {};

const getNoteString = (noteJson: Record<string, unknown>, key: string) =>
  asString(noteJson[key]);

const getNoteRecord = (noteJson: Record<string, unknown>, key: string) =>
  asRecord(noteJson[key]) ?? {};

const normalizeName = (name: string) =>
  name.replace(/\s+/g, " ").trim() || UNKNOWN_PATIENT;

const normalizeNameKey = (name: string) => normalizeName(name).toLowerCase();

const parseAge = (age: string) => {
  const parsedAge = Number.parseInt(age, 10);

  return Number.isFinite(parsedAge) && parsedAge >= 0 && parsedAge <= 130
    ? parsedAge
    : null;
};

const toVisitTimestamp = (visitDate: string) => {
  const trimmedDate = visitDate.trim();

  if (!trimmedDate) {
    return null;
  }

  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmedDate)) {
    return `${trimmedDate}T00:00:00.000Z`;
  }

  const parsedDate = new Date(trimmedDate);

  return Number.isNaN(parsedDate.getTime()) ? null : parsedDate.toISOString();
};

const getCurrentUser = async (): Promise<CurrentSupabaseUser> => {
  const {
    data: { user },
    error,
  } = await supabase.auth.getUser();

  if (error || !user) {
    throw new Error("Sign in before saving patient records.");
  }

  return { id: user.id };
};

const throwIfSupabaseError = (
  error: { message?: string } | null,
  fallback: string,
) => {
  if (error) {
    throw new Error(error.message ? `${fallback}: ${error.message}` : fallback);
  }
};

const getRelatedPatient = (value: unknown): PatientRow | null => {
  const patient = Array.isArray(value) ? value[0] : value;
  const record = asRecord(patient);

  if (!record || typeof record.id !== "string" || typeof record.name !== "string") {
    return null;
  }

  return {
    id: record.id,
    name: record.name,
    name_key:
      typeof record.name_key === "string"
        ? record.name_key
        : normalizeNameKey(record.name),
    patient_identifier:
      typeof record.patient_identifier === "string"
        ? record.patient_identifier
        : null,
    age: typeof record.age === "number" ? record.age : null,
    gender: typeof record.gender === "string" ? record.gender : null,
    created_at:
      typeof record.created_at === "string" ? record.created_at : null,
    updated_at:
      typeof record.updated_at === "string" ? record.updated_at : null,
  };
};

const mapPatientProfile = (patient: PatientRow): PatientProfile => {
  const now = new Date().toISOString();

  return {
    profileId: patient.id,
    patientId: patient.patient_identifier ?? undefined,
    name: patient.name,
    age: patient.age ?? undefined,
    gender: patient.gender ?? undefined,
    createdAt: patient.created_at ?? now,
    updatedAt: patient.updated_at ?? patient.created_at ?? now,
  };
};

const getNoteJson = (value: unknown): Record<string, unknown> =>
  asRecord(value) ?? {};

const getRecordingCount = (noteJson: Record<string, unknown>) => {
  const recordings = noteJson.recordings;

  return Array.isArray(recordings) ? recordings.length : 0;
};

const makeTitle = (
  noteJson: Record<string, unknown>,
  transcript: string,
  explicitTitle = "",
) => {
  const titleSource =
    explicitTitle ||
    getNoteString(noteJson, "title") ||
    getNoteString(noteJson, "visit_summary") ||
    transcript;
  const title = titleSource.replace(/\s+/g, " ").trim();

  return title || "Clinic note";
};

const mapEncounterSummary = (row: EncounterRow): EncounterSummary => {
  const noteJson = getNoteJson(row.note_json);
  const patient = getRelatedPatient(row.patient);
  const now = new Date().toISOString();

  return {
    id: row.id,
    legacyNoteId: row.legacy_note_id ?? undefined,
    title: row.title || makeTitle(noteJson, row.transcript ?? ""),
    createdAt: row.created_at ?? now,
    updatedAt: row.updated_at ?? row.created_at ?? now,
    patientProfileId: patient?.id,
    patientId: patient?.patient_identifier ?? undefined,
    patientName: patient?.name ?? UNKNOWN_PATIENT,
    patientAge: patient?.age ?? undefined,
    patientGender: patient?.gender ?? undefined,
    diagnosis: row.diagnosis ?? undefined,
    visitDate: row.visit_date ?? undefined,
    languageDetected: row.language_detected ?? getNoteString(noteJson, "language_detected"),
    providerUsed: row.provider_used ?? getNoteString(noteJson, "provider_used"),
    recordingCount: getRecordingCount(noteJson),
    translationLanguages: asStringArray(noteJson.translation_languages),
    pinned: row.pinned === true,
    pinnedAt: row.pinned_at ?? undefined,
  };
};

const mapEncounterDetail = (row: EncounterRow): EncounterDetail => ({
  ...mapEncounterSummary(row),
  transcript: row.transcript ?? "",
  result: getNoteJson(row.note_json),
});

const selectEncounterColumns = [
  "id",
  "legacy_note_id",
  "title",
  "transcript",
  "note_json",
  "summary",
  "diagnosis",
  "visit_date",
  "language_detected",
  "provider_used",
  "pinned",
  "pinned_at",
  "created_at",
  "updated_at",
  "patient:patients(id,name,name_key,patient_identifier,age,gender,created_at,updated_at)",
].join(",");

const selectPatientColumns =
  "id,name,name_key,patient_identifier,age,gender,created_at,updated_at";

const upsertPatient = async (
  userId: string,
  patientDraft: PatientDraft,
): Promise<PatientRow> => {
  const name = normalizeName(patientDraft.name);
  const nameKey = normalizeNameKey(name);
  const patientId = patientDraft.patientId.trim() || null;
  const age = parseAge(patientDraft.age);
  const gender = patientDraft.gender.trim() || null;

  const { data: selectedPatient, error: selectedPatientError } =
    patientDraft.patientProfileId
      ? await supabase
          .from("patients")
          .select(selectPatientColumns)
          .eq("user_id", userId)
          .eq("id", patientDraft.patientProfileId)
          .maybeSingle()
      : { data: null, error: null };

  throwIfSupabaseError(selectedPatientError, "Unable to find selected patient");

  const lookupQuery = supabase
    .from("patients")
    .select(selectPatientColumns)
    .eq("user_id", userId);
  const { data: existingPatient, error: lookupError } = selectedPatient
    ? { data: selectedPatient, error: null }
    : patientId
      ? await lookupQuery.eq("patient_identifier", patientId).maybeSingle()
      : await lookupQuery.eq("name_key", nameKey).maybeSingle();

  throwIfSupabaseError(lookupError, "Unable to find existing patient");

  const { data: existingNamedPatient, error: nameLookupError } =
    patientId && !existingPatient
      ? await supabase
          .from("patients")
          .select(selectPatientColumns)
          .eq("user_id", userId)
          .eq("name_key", nameKey)
          .maybeSingle()
      : { data: null, error: null };

  throwIfSupabaseError(nameLookupError, "Unable to find existing patient");

  const patientToUpdate = existingPatient ?? existingNamedPatient;

  if (patientToUpdate) {
    const { data, error } = await supabase
      .from("patients")
      .update({
        name,
        patient_identifier: patientId ?? patientToUpdate.patient_identifier,
        age: age ?? patientToUpdate.age,
        gender: gender ?? patientToUpdate.gender,
        updated_at: new Date().toISOString(),
      })
      .eq("id", patientToUpdate.id)
      .select(selectPatientColumns)
      .single();

    throwIfSupabaseError(error, "Unable to update patient");

    return data as PatientRow;
  }

  const { data, error } = await supabase
    .from("patients")
    .insert({
      user_id: userId,
      name,
      name_key: nameKey,
      patient_identifier: patientId,
      age,
      gender,
    })
    .select(selectPatientColumns)
    .single();

  throwIfSupabaseError(error, "Unable to create patient");

  return data as PatientRow;
};

const getEncounterById = async (encounterId: string, userId?: string) => {
  const user = userId ? { id: userId } : await getCurrentUser();
  const { data, error } = await supabase
    .from("encounters")
    .select(selectEncounterColumns)
    .eq("user_id", user.id)
    .eq("id", encounterId)
    .single();

  throwIfSupabaseError(error, "Unable to load encounter");

  return data as unknown as EncounterRow;
};

export const listEncounterSummaries = async () => {
  const user = await getCurrentUser();
  const { data, error } = await supabase
    .from("encounters")
    .select(selectEncounterColumns)
    .eq("user_id", user.id)
    .order("pinned", { ascending: false })
    .order("updated_at", { ascending: false });

  throwIfSupabaseError(error, "Unable to load dashboard records");

  return ((data ?? []) as unknown as EncounterRow[]).map(mapEncounterSummary);
};

export const getEncounterDetail = async (encounterId: string) =>
  mapEncounterDetail(await getEncounterById(encounterId));

export const listPatientProfiles = async () => {
  const user = await getCurrentUser();
  const { data, error } = await supabase
    .from("patients")
    .select(selectPatientColumns)
    .eq("user_id", user.id)
    .order("updated_at", { ascending: false });

  throwIfSupabaseError(error, "Unable to load patient profiles");

  return ((data ?? []) as PatientRow[]).map(mapPatientProfile);
};

export const savePatientProfile = async (
  patientDraft: Pick<
    PatientDraft,
    "patientProfileId" | "patientId" | "name" | "age" | "gender"
  >,
) => {
  const user = await getCurrentUser();
  const patient = await upsertPatient(user.id, {
    ...patientDraft,
    visitDate: "",
    diagnosis: "",
  });

  return mapPatientProfile(patient);
};

export const saveEncounterRecord = async (input: {
  encounterId?: string;
  patientDraft: PatientDraft;
  noteJson: Record<string, unknown>;
  transcript: string;
  title?: string;
}) => {
  const user = await getCurrentUser();
  const patient = await upsertPatient(user.id, input.patientDraft);
  const noteJson = input.noteJson;
  const patientMetadata = getNestedRecord(noteJson, "patient");
  const encounterMetadata = getNestedRecord(noteJson, "encounter");
  const soap = getNoteRecord(noteJson, "soap");
  const summary = getNoteString(noteJson, "visit_summary");
  const diagnosis =
    input.patientDraft.diagnosis.trim() ||
    asString(encounterMetadata.diagnosis) ||
    asString(soap.assessment);
  const visitDate = toVisitTimestamp(input.patientDraft.visitDate);
  const title = makeTitle(noteJson, input.transcript, input.title);
  const now = new Date().toISOString();
  const payload = {
    user_id: user.id,
    patient_id: patient.id,
    legacy_note_id: getNoteString(noteJson, "note_id") || null,
    title,
    transcript: input.transcript,
    note_json: {
      ...noteJson,
      patient: {
        ...patientMetadata,
        patient_profile_id: patient.id,
        patient_id: patient.patient_identifier ?? "",
        patient_identifier: patient.patient_identifier ?? "",
        name: patient.name,
        age: patient.age,
        gender: patient.gender ?? "",
      },
      encounter: {
        ...encounterMetadata,
        visit_date: input.patientDraft.visitDate.trim(),
        diagnosis,
      },
    },
    summary,
    diagnosis,
    visit_date: visitDate,
    language_detected: getNoteString(noteJson, "language_detected") || null,
    provider_used: getNoteString(noteJson, "provider_used") || null,
    updated_at: now,
  };

  if (input.encounterId) {
    const { data, error } = await supabase
      .from("encounters")
      .update(payload)
      .eq("user_id", user.id)
      .eq("id", input.encounterId)
      .select("id")
      .single();

    throwIfSupabaseError(error, "Unable to update encounter");

    return mapEncounterDetail(
      await getEncounterById((data as { id: string }).id, user.id),
    );
  }

  const { data, error } = await supabase
    .from("encounters")
    .insert(payload)
    .select("id")
    .single();

  throwIfSupabaseError(error, "Unable to save encounter");

  return mapEncounterDetail(
    await getEncounterById((data as { id: string }).id, user.id),
  );
};

export const updateEncounterSummary = async (
  encounterId: string,
  updates: { title?: string; pinned?: boolean },
) => {
  const user = await getCurrentUser();
  const patch: Record<string, unknown> = {
    updated_at: new Date().toISOString(),
  };

  if (typeof updates.title === "string") {
    patch.title = updates.title;
  }

  if (typeof updates.pinned === "boolean") {
    patch.pinned = updates.pinned;
    patch.pinned_at = updates.pinned ? new Date().toISOString() : null;
  }

  const { data, error } = await supabase
    .from("encounters")
    .update(patch)
    .eq("user_id", user.id)
    .eq("id", encounterId)
    .select("id")
    .single();

  throwIfSupabaseError(error, "Unable to update dashboard record");

  return mapEncounterSummary(
    await getEncounterById((data as { id: string }).id, user.id),
  );
};

export const deleteEncounterRecord = async (encounterId: string) => {
  const user = await getCurrentUser();
  const { error } = await supabase
    .from("encounters")
    .delete()
    .eq("user_id", user.id)
    .eq("id", encounterId);

  throwIfSupabaseError(error, "Unable to delete dashboard record");
};
