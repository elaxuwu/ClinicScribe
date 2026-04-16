import { type User } from "@supabase/supabase-js";
import { type FormEvent, useEffect, useRef, useState } from "react";
import {
  deleteEncounterRecord,
  getEncounterDetail,
  listPatientProfiles,
  listEncounterSummaries,
  saveEncounterRecord,
  savePatientProfile,
  updateEncounterSummary,
  type EncounterSummary,
  type PatientDraft,
  type PatientProfile,
} from "./utils/clinicRecords";
import { supabase } from "./utils/supabase";

type TranscriptionSegment = {
  speaker?: string | number;
  speaker_id?: string | number;
  speaker_label?: string | number;
  text?: string;
};

type TranscriptionResponse = {
  text?: string;
  segments?: unknown;
  recording?: unknown;
  [key: string]: unknown;
};

type NoteResult = {
  note_id?: unknown;
  title?: unknown;
  saved_at?: unknown;
  updated_at?: unknown;
  translation_languages?: unknown;
  recordings?: unknown;
  pinned?: unknown;
  pinned_at?: unknown;
  chat_history?: unknown;
  language_detected?: unknown;
  provider_used?: unknown;
  patient?: {
    patient_profile_id?: unknown;
    patient_id?: unknown;
    patient_identifier?: unknown;
    name?: unknown;
    age?: unknown;
    gender?: unknown;
    date_of_birth?: unknown;
  };
  encounter?: {
    visit_date?: unknown;
    chief_complaint?: unknown;
    diagnosis?: unknown;
  };
  soap?: {
    subjective?: unknown;
    objective?: unknown;
    assessment?: unknown;
    plan?: unknown;
  };
  visit_summary?: unknown;
  extracted?: {
    symptoms?: unknown;
    medications?: unknown;
    follow_up_plan?: unknown;
    red_flags?: unknown;
  };
  discharge_instructions?: unknown;
  uncertainties?: unknown;
};

type CurrentUser = {
  id: string;
  email: string;
  name: string;
  createdAt: string;
  isGuest?: boolean;
};

type AuthMode = "login" | "signup";

type AppView = "scribe" | "dashboard" | "note" | "patient";

type SavedNoteSummary = {
  id: string;
  legacyNoteId?: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  patientProfileId?: string;
  patientId?: string;
  patientName?: string;
  patientAge?: number;
  patientGender?: string;
  diagnosis?: string;
  visitDate?: string;
  language_detected?: string;
  provider_used?: string;
  translation_languages?: string[];
  recording_count?: number;
  pinned?: boolean;
  pinnedAt?: string;
};

type NoteRecording = {
  id: string;
  name: string;
  type: string;
  size: number;
  createdAt: string;
  transcript: string;
  dataUrl?: string;
};

type TranslateResponse = {
  note_id?: string;
  title?: string;
  language?: string;
  cached?: boolean;
  result?: NoteResult;
  error?: string;
  details?: unknown;
};

type NoteChatRole = "user" | "assistant";

type NoteChatMessage = {
  id: string;
  role: NoteChatRole;
  content: string;
  selectedText?: string;
  createdAt: string;
};

type EditNoteResponse = {
  message?: string;
  changed?: boolean;
  result?: NoteResult;
  error?: string;
  details?: unknown;
};

type DashboardSort = "newest" | "oldest" | "patient";
type DashboardFilters = {
  patientNames: string[];
  patientIds: string[];
  genders: string[];
  ageMin: string;
  ageMax: string;
  diagnosis: string;
  visitDateFrom: string;
  visitDateTo: string;
};
type IconName =
  | "trash"
  | "pen"
  | "pin"
  | "pinOff"
  | "filter"
  | "refresh"
  | "mic"
  | "stop"
  | "eraser"
  | "home"
  | "dashboard"
  | "chat"
  | "send"
  | "x";

const LANGUAGE_OPTIONS = [
  "Vietnamese",
  "English",
  "Spanish",
  "French",
  "German",
  "Chinese",
  "Japanese",
  "Korean",
  "Tagalog",
  "Arabic",
  "Hindi",
  "Portuguese",
  "Russian",
  "Thai",
  "Indonesian",
];

const AUTOSAVE_DELAY_MS = 600;
const NOTE_RECORD_AUTOSAVE_DELAY_MS = 900;
const NOTE_CHAT_HISTORY_LIMIT = 80;
const BRAND_LOGO_SRC = "/brand/logo.png?v=2";
const GUEST_SESSION_KEY = "clinicscribe.guest.active";
const GUEST_ID_KEY = "clinicscribe.guest.id";
const GUEST_RECORDS_PREFIX = "clinicscribe.guest.records";
const GUEST_PATIENT_PROFILES_PREFIX = "clinicscribe.guest.patients";
const GUEST_SYNC_SOURCE_KEY = "clinicscribe.guest.syncSourceId";
const EMPTY_DASHBOARD_FILTERS: DashboardFilters = {
  patientNames: [],
  patientIds: [],
  genders: [],
  ageMin: "",
  ageMax: "",
  diagnosis: "",
  visitDateFrom: "",
  visitDateTo: "",
};

const VIEW_PATHS: Record<AppView, string> = {
  scribe: "/",
  dashboard: "/dashboard",
  note: "/note",
  patient: "/patients",
};

const getViewFromPathname = (pathname: string): AppView => {
  const normalizedPath = pathname.replace(/\/+$/, "") || "/";

  if (normalizedPath.startsWith(`${VIEW_PATHS.patient}/`)) {
    return "patient";
  }

  if (normalizedPath === VIEW_PATHS.dashboard) {
    return "dashboard";
  }

  if (normalizedPath === VIEW_PATHS.note) {
    return "note";
  }

  return "scribe";
};

const getAutosaveKey = (userId: string) => `clinicscribe.autosave.${userId}`;
const getGuestRecordsKey = (guestId: string) =>
  `${GUEST_RECORDS_PREFIX}.${guestId}`;
const getGuestPatientProfilesKey = (guestId: string) =>
  `${GUEST_PATIENT_PROFILES_PREFIX}.${guestId}`;
const getPatientProfilePath = (profileId: string) =>
  `${VIEW_PATHS.patient}/${encodeURIComponent(profileId)}`;
const getPatientProfileIdFromPathname = (pathname: string) => {
  const normalizedPath = pathname.replace(/\/+$/, "");
  const prefix = `${VIEW_PATHS.patient}/`;

  return normalizedPath.startsWith(prefix)
    ? decodeURIComponent(normalizedPath.slice(prefix.length))
    : "";
};

const clearAutosavedDraft = (user: CurrentUser | null) => {
  if (!user) {
    return;
  }

  localStorage.removeItem(getAutosaveKey(user.id));
};

const getAutosaveTimeLabel = () =>
  new Intl.DateTimeFormat(undefined, {
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
  }).format(new Date());

const asNoteResultDraft = (value: unknown) =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as NoteResult)
    : null;

const asRecord = (value: unknown) =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

const toRecording = (
  value: unknown,
  transcriptFallback = "",
): NoteRecording | null => {
  const recording = asRecord(value);

  if (
    typeof recording?.id !== "string" ||
    typeof recording.name !== "string" ||
    typeof recording.type !== "string" ||
    typeof recording.createdAt !== "string" ||
    typeof recording.size !== "number"
  ) {
    return null;
  }

  return {
    id: recording.id,
    name: recording.name,
    type: recording.type,
    size: recording.size,
    createdAt: recording.createdAt,
    transcript:
      typeof recording.transcript === "string"
        ? recording.transcript
        : transcriptFallback,
    dataUrl:
      typeof recording.dataUrl === "string" ? recording.dataUrl : undefined,
  };
};

const getNoteRecordings = (value: unknown) => {
  const record = asRecord(value);
  const recordings = record?.recordings;

  return Array.isArray(recordings)
    ? recordings
        .map((recording) => toRecording(recording))
        .filter((recording): recording is NoteRecording => recording !== null)
    : [];
};

const Icon = ({ name }: { name: IconName }) => {
  const commonProps = {
    className: "h-4 w-4",
    fill: "none",
    stroke: "currentColor",
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    strokeWidth: 2,
    viewBox: "0 0 24 24",
  };

  switch (name) {
    case "trash":
      return (
        <svg {...commonProps} aria-hidden="true">
          <path d="M3 6h18" />
          <path d="M8 6V4h8v2" />
          <path d="M19 6l-1 14H6L5 6" />
          <path d="M10 11v5" />
          <path d="M14 11v5" />
        </svg>
      );
    case "pen":
      return (
        <svg {...commonProps} aria-hidden="true">
          <path d="M12 20h9" />
          <path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" />
        </svg>
      );
    case "pin":
      return (
        <svg {...commonProps} aria-hidden="true">
          <path d="M12 17v5" />
          <path d="M5 17h14" />
          <path d="M8 17l1-8-3-3V4h12v2l-3 3 1 8" />
        </svg>
      );
    case "pinOff":
      return (
        <svg {...commonProps} aria-hidden="true">
          <path d="M12 17v5" />
          <path d="M5 17h12" />
          <path d="M8 17l1-8-3-3V4h4" />
          <path d="M14 4h4v2l-2.1 2.1" />
          <path d="M3 3l18 18" />
        </svg>
      );
    case "filter":
      return (
        <svg {...commonProps} aria-hidden="true">
          <path d="M4 5h16" />
          <path d="M7 12h10" />
          <path d="M10 19h4" />
        </svg>
      );
    case "refresh":
      return (
        <svg {...commonProps} aria-hidden="true">
          <path d="M20 11a8 8 0 0 0-14.7-4" />
          <path d="M5 3v5h5" />
          <path d="M4 13a8 8 0 0 0 14.7 4" />
          <path d="M19 21v-5h-5" />
        </svg>
      );
    case "mic":
      return (
        <svg {...commonProps} aria-hidden="true">
          <path d="M12 3a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V6a3 3 0 0 0-3-3Z" />
          <path d="M19 11a7 7 0 0 1-14 0" />
          <path d="M12 18v3" />
          <path d="M8 21h8" />
        </svg>
      );
    case "stop":
      return (
        <svg {...commonProps} aria-hidden="true">
          <path d="M7 7h10v10H7z" />
        </svg>
      );
    case "eraser":
      return (
        <svg {...commonProps} aria-hidden="true">
          <path d="M20 20H9" />
          <path d="M16.5 3.5 21 8l-9.5 9.5H7L3 13.5Z" />
          <path d="m7 17-4-4" />
        </svg>
      );
    case "home":
      return (
        <svg {...commonProps} aria-hidden="true">
          <path d="m3 11 9-8 9 8" />
          <path d="M5 10v10h14V10" />
          <path d="M9 20v-6h6v6" />
        </svg>
      );
    case "dashboard":
      return (
        <svg {...commonProps} aria-hidden="true">
          <path d="M4 4h7v7H4z" />
          <path d="M13 4h7v5h-7z" />
          <path d="M13 11h7v9h-7z" />
          <path d="M4 13h7v7H4z" />
        </svg>
      );
    case "chat":
      return (
        <svg {...commonProps} aria-hidden="true">
          <path d="M21 12a8 8 0 0 1-8 8H7l-4 3v-6.5A8 8 0 1 1 21 12Z" />
          <path d="M8 11h8" />
          <path d="M8 15h5" />
        </svg>
      );
    case "send":
      return (
        <svg {...commonProps} aria-hidden="true">
          <path d="m22 2-7 20-4-9-9-4Z" />
          <path d="M22 2 11 13" />
        </svg>
      );
    case "x":
      return (
        <svg {...commonProps} aria-hidden="true">
          <path d="M18 6 6 18" />
          <path d="m6 6 12 12" />
        </svg>
      );
    default:
      return null;
  }
};

const iconButtonClass =
  "inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border border-zinc-300 text-zinc-700 transition hover:border-zinc-400 hover:bg-white disabled:cursor-not-allowed disabled:border-zinc-200 disabled:text-zinc-400";

const dangerIconButtonClass =
  "inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border border-red-200 text-red-700 transition hover:border-red-300 hover:bg-red-50 disabled:cursor-not-allowed disabled:border-red-100 disabled:text-red-300";

const IconButton = ({
  label,
  icon,
  onClick,
  disabled,
  danger = false,
}: {
  label: string;
  icon: IconName;
  onClick: () => void;
  disabled?: boolean;
  danger?: boolean;
}) => (
  <button
    aria-label={label}
    className={danger ? dangerIconButtonClass : iconButtonClass}
    disabled={disabled}
    onClick={onClick}
    title={label}
    type="button"
  >
    <Icon name={icon} />
  </button>
);

const upsertSavedNoteSummary = (
  notes: SavedNoteSummary[],
  note: SavedNoteSummary,
) => sortSavedNotes([note, ...notes.filter((savedNote) => savedNote.id !== note.id)]);

const sortSavedNotes = (notes: SavedNoteSummary[]) =>
  [...notes].sort((left, right) => {
    if (left.pinned !== right.pinned) {
      return left.pinned ? -1 : 1;
    }

    return getSavedNoteVisitTime(right) - getSavedNoteVisitTime(left);
  });

const getTimestamp = (value?: string) => {
  if (!value) {
    return 0;
  }

  const timestamp = Date.parse(value);

  return Number.isNaN(timestamp) ? 0 : timestamp;
};

const getSavedNoteVisitTime = (note: SavedNoteSummary) =>
  getTimestamp(note.visitDate) || getTimestamp(note.createdAt);

const normalizeFilterKey = (value?: string) =>
  (value ?? "").trim().toLowerCase();

const getUniqueSortedValues = (values: Array<string | undefined>) => {
  const options = new Map<string, string>();

  values.forEach((value) => {
    const trimmedValue = value?.trim();

    if (!trimmedValue) {
      return;
    }

    const key = normalizeFilterKey(trimmedValue);

    if (!options.has(key)) {
      options.set(key, trimmedValue);
    }
  });

  return [...options.values()].sort((left, right) => left.localeCompare(right));
};

const selectionIncludes = (selectedValues: string[], value?: string) => {
  if (selectedValues.length === 0) {
    return true;
  }

  const key = normalizeFilterKey(value);

  return (
    Boolean(key) &&
    selectedValues.some((selected) => normalizeFilterKey(selected) === key)
  );
};

const parseFilterNumber = (value: string) => {
  const parsedValue = Number.parseInt(value, 10);

  return Number.isFinite(parsedValue) ? parsedValue : undefined;
};

const getActiveDashboardFilterCount = (filters: DashboardFilters) =>
  [
    filters.patientNames.length > 0,
    filters.patientIds.length > 0,
    filters.genders.length > 0,
    Boolean(filters.ageMin.trim() || filters.ageMax.trim()),
    Boolean(filters.diagnosis.trim()),
    Boolean(filters.visitDateFrom || filters.visitDateTo),
  ].filter(Boolean).length;

const toggleFilterValue = (values: string[], value: string) =>
  values.some(
    (selected) => normalizeFilterKey(selected) === normalizeFilterKey(value),
  )
    ? values.filter(
        (selected) => normalizeFilterKey(selected) !== normalizeFilterKey(value),
      )
    : [...values, value];

const formatPatientProfileLabel = (profile: PatientProfile) =>
  [
    profile.name,
    profile.age === undefined ? "" : `Age ${profile.age}`,
    profile.patientId ? `ID ${profile.patientId}` : "",
    profile.gender ?? "",
  ]
    .filter(Boolean)
    .join(" - ");

const getPatientProfileDraftPatch = (
  profile: PatientProfile,
): Pick<PatientDraft, "patientProfileId" | "patientId" | "name" | "age" | "gender"> => ({
  patientProfileId: profile.profileId,
  patientId: profile.patientId ?? "",
  name: profile.name,
  age: profile.age === undefined ? "" : String(profile.age),
  gender: profile.gender ?? "",
});

const savedNoteMatchesPatientProfile = (
  savedNote: SavedNoteSummary,
  profile: PatientProfile,
) => {
  if (savedNote.patientProfileId && savedNote.patientProfileId === profile.profileId) {
    return true;
  }

  if (
    savedNote.patientId &&
    profile.patientId &&
    normalizeFilterKey(savedNote.patientId) === normalizeFilterKey(profile.patientId)
  ) {
    return true;
  }

  return (
    normalizePatientProfileKey(savedNote.patientName ?? "") ===
    normalizePatientProfileKey(profile.name)
  );
};

const upsertPatientProfileList = (
  profiles: PatientProfile[],
  profile: PatientProfile,
) =>
  [profile, ...profiles.filter((existing) => existing.profileId !== profile.profileId)].sort(
    (left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt),
  );

const getSupportedMimeType = () => {
  const types = [
    "audio/webm;codecs=opus",
    "audio/webm",
    "audio/mp4",
    "audio/ogg;codecs=opus",
  ];

  return types.find((type) => MediaRecorder.isTypeSupported(type)) ?? "";
};

const getAudioFileName = (mimeType: string) => {
  if (mimeType.includes("mp4")) {
    return "clinic-recording.mp4";
  }

  if (mimeType.includes("ogg")) {
    return "clinic-recording.ogg";
  }

  return "clinic-recording.webm";
};

const isTranscriptionSegment = (value: unknown): value is TranscriptionSegment =>
  Boolean(value && typeof value === "object" && "text" in value);

const getSpeakerLabel = (segment: TranscriptionSegment, index: number) => {
  const speaker =
    segment.speaker_label ?? segment.speaker ?? segment.speaker_id ?? index + 1;

  return String(speaker).replace(/^speaker[_\s-]?/i, "Speaker ");
};

const formatTranscript = (result: TranscriptionResponse) => {
  if (Array.isArray(result.segments)) {
    const lines: string[] = [];
    let currentSpeaker = "";
    let currentText = "";

    result.segments.filter(isTranscriptionSegment).forEach((segment, index) => {
      const text = typeof segment.text === "string" ? segment.text.trim() : "";

      if (!text) {
        return;
      }

      const speaker = getSpeakerLabel(segment, index);

      if (speaker === currentSpeaker) {
        currentText = `${currentText} ${text}`.trim();
        return;
      }

      if (currentText) {
        lines.push(`${currentSpeaker}: ${currentText}`);
      }

      currentSpeaker = speaker;
      currentText = text;
    });

    if (currentText) {
      lines.push(`${currentSpeaker}: ${currentText}`);
    }

    if (lines.length > 0) {
      return lines.join("\n");
    }
  }

  return typeof result.text === "string" ? result.text : "";
};

const getErrorMessage = (value: unknown, fallback: string) => {
  if (value && typeof value === "object" && "error" in value) {
    const error = (value as { error?: unknown }).error;
    const details = (value as { details?: unknown }).details;

    if (typeof error === "string") {
      if (typeof details === "string" && details.trim()) {
        return `${error} Details: ${details}`;
      }

      return error;
    }
  }

  return fallback;
};

const asText = (value: unknown) =>
  typeof value === "string" && value.trim() ? value : "Not documented.";

const asStringArray = (value: unknown) =>
  Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];

const getProviderLabel = (value: unknown) => {
  if (value === "featherless") {
    return "Featherless";
  }

  if (value === "ollama") {
    return "Ollama fallback";
  }

  return "";
};

const getStringValue = (value: unknown) =>
  typeof value === "string" ? value.trim() : "";

const getNoteId = (note: NoteResult | null) => getStringValue(note?.note_id);

const toNoteRecord = (note: NoteResult | null): Record<string, unknown> =>
  note && typeof note === "object" ? (note as Record<string, unknown>) : {};

const createNoteChatMessageId = () => `chat_${crypto.randomUUID()}`;

const normalizeNoteChatMessage = (value: unknown): NoteChatMessage | null => {
  const record = asRecord(value);
  const role = record?.role === "assistant" ? "assistant" : "user";
  const content = getStringValue(record?.content);

  if (!content) {
    return null;
  }

  return {
    id:
      typeof record?.id === "string" && record.id.trim()
        ? record.id
        : createNoteChatMessageId(),
    role,
    content,
    selectedText:
      typeof record?.selectedText === "string" && record.selectedText.trim()
        ? record.selectedText.trim()
        : undefined,
    createdAt:
      typeof record?.createdAt === "string" && record.createdAt.trim()
        ? record.createdAt
        : new Date().toISOString(),
  };
};

const getNoteChatHistory = (note: NoteResult | null) =>
  Array.isArray(note?.chat_history)
    ? note.chat_history
        .map(normalizeNoteChatMessage)
        .filter((message): message is NoteChatMessage => message !== null)
        .slice(-NOTE_CHAT_HISTORY_LIMIT)
    : [];

const withNoteChatHistory = (
  note: NoteResult | null,
  chatHistory: NoteChatMessage[],
) =>
  note
    ? {
        ...note,
        chat_history: chatHistory.slice(-NOTE_CHAT_HISTORY_LIMIT),
      }
    : note;

const toLocalDateInputValue = (date: Date) => {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");

  return `${year}-${month}-${day}`;
};

const getTodayDateInputValue = () => toLocalDateInputValue(new Date());

const getDateInputValue = (value: unknown) => {
  const rawValue = getStringValue(value);

  if (!rawValue) {
    return "";
  }

  if (/^\d{4}-\d{2}-\d{2}$/.test(rawValue)) {
    return rawValue;
  }

  const date = new Date(rawValue);

  return Number.isNaN(date.getTime()) ? "" : toLocalDateInputValue(date);
};

const getAgeInputValue = (value: unknown) => {
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }

  return getStringValue(value);
};

const getPatientDraftFromNote = (note: NoteResult | null): PatientDraft => {
  const patient = asRecord(note?.patient) ?? {};
  const encounter = asRecord(note?.encounter) ?? {};
  const soap = asRecord(note?.soap) ?? {};

  return {
    patientProfileId: getStringValue(patient.patient_profile_id) || undefined,
    patientId:
      getStringValue(patient.patient_id) ||
      getStringValue(patient.patient_identifier),
    name: getStringValue(patient.name),
    age: getAgeInputValue(patient.age),
    gender: getStringValue(patient.gender),
    visitDate: getDateInputValue(encounter.visit_date) || getTodayDateInputValue(),
    diagnosis:
      getStringValue(encounter.diagnosis) || getStringValue(soap.assessment),
  };
};

const toCurrentUser = (user: User): CurrentUser => {
  const metadata = user.user_metadata;
  const name =
    typeof metadata?.name === "string"
      ? metadata.name.trim()
      : typeof metadata?.full_name === "string"
        ? metadata.full_name.trim()
        : "";

  return {
    id: user.id,
    email: user.email ?? "",
    name: name || user.email || "Clinic user",
    createdAt: user.created_at,
  };
};

const getOrCreateGuestId = () => {
  const existingGuestId = localStorage.getItem(GUEST_ID_KEY);

  if (existingGuestId) {
    return existingGuestId;
  }

  const guestId = `guest_${crypto.randomUUID()}`;
  localStorage.setItem(GUEST_ID_KEY, guestId);

  return guestId;
};

const makeGuestUser = (): CurrentUser => ({
  id: getOrCreateGuestId(),
  email: "Saved on this browser",
  name: "Guest",
  createdAt: new Date().toISOString(),
  isGuest: true,
});

const setGuestModeActive = (isActive: boolean) => {
  if (isActive) {
    localStorage.setItem(GUEST_SESSION_KEY, "true");
    return;
  }

  localStorage.removeItem(GUEST_SESSION_KEY);
};

const getActiveGuestUser = () =>
  localStorage.getItem(GUEST_SESSION_KEY) === "true" ? makeGuestUser() : null;

const setPendingGuestSync = (guestId: string) => {
  sessionStorage.setItem(GUEST_SYNC_SOURCE_KEY, guestId);
};

const getPendingGuestSync = () => sessionStorage.getItem(GUEST_SYNC_SOURCE_KEY);

const clearPendingGuestSync = () => {
  sessionStorage.removeItem(GUEST_SYNC_SOURCE_KEY);
};

const getSupabaseAccessToken = async () => {
  const {
    data: { session },
    error,
  } = await supabase.auth.getSession();

  if (error || !session?.access_token) {
    throw new Error("Sign in before using ClinicScribe.");
  }

  return session.access_token;
};

const apiFetch = async (
  input: RequestInfo | URL,
  init: RequestInit = {},
  options: { guestId?: string } = {},
) => {
  const headers = new Headers(init.headers);

  if (options.guestId) {
    headers.set("X-ClinicScribe-Guest", "local");
    headers.set("X-ClinicScribe-Guest-Id", options.guestId);
  } else {
    const accessToken = await getSupabaseAccessToken();
    headers.set("Authorization", `Bearer ${accessToken}`);
  }

  return fetch(input, {
    ...init,
    headers,
    credentials: "same-origin",
  });
};

const toSavedNoteSummary = (encounter: EncounterSummary): SavedNoteSummary => ({
  id: encounter.id,
  legacyNoteId: encounter.legacyNoteId,
  title: encounter.title,
  createdAt: encounter.createdAt,
  updatedAt: encounter.updatedAt,
  patientProfileId: encounter.patientProfileId,
  patientId: encounter.patientId,
  patientName: encounter.patientName,
  patientAge: encounter.patientAge,
  patientGender: encounter.patientGender,
  diagnosis: encounter.diagnosis,
  visitDate: encounter.visitDate,
  language_detected: encounter.languageDetected,
  provider_used: encounter.providerUsed,
  recording_count: encounter.recordingCount,
  pinned: encounter.pinned,
  pinnedAt: encounter.pinnedAt,
  translation_languages: encounter.translationLanguages,
});

type GuestEncounterRecord = EncounterSummary & {
  transcript: string;
  result: Record<string, unknown>;
};

const toGuestEncounterRecord = (value: unknown): GuestEncounterRecord | null => {
  const record = asRecord(value);
  const result = asRecord(record?.result);

  if (
    !record ||
    !result ||
    typeof record.id !== "string" ||
    typeof record.title !== "string" ||
    typeof record.createdAt !== "string" ||
    typeof record.updatedAt !== "string" ||
    typeof record.patientName !== "string" ||
    typeof record.recordingCount !== "number" ||
    typeof record.transcript !== "string"
  ) {
    return null;
  }

  return {
    id: record.id,
    legacyNoteId:
      typeof record.legacyNoteId === "string" ? record.legacyNoteId : undefined,
    title: record.title,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    patientProfileId:
      typeof record.patientProfileId === "string"
        ? record.patientProfileId
        : undefined,
    patientId: typeof record.patientId === "string" ? record.patientId : undefined,
    patientName: record.patientName,
    patientAge: typeof record.patientAge === "number" ? record.patientAge : undefined,
    patientGender:
      typeof record.patientGender === "string" ? record.patientGender : undefined,
    diagnosis: typeof record.diagnosis === "string" ? record.diagnosis : undefined,
    visitDate: typeof record.visitDate === "string" ? record.visitDate : undefined,
    languageDetected:
      typeof record.languageDetected === "string"
        ? record.languageDetected
        : undefined,
    providerUsed:
      typeof record.providerUsed === "string" ? record.providerUsed : undefined,
    recordingCount: record.recordingCount,
    translationLanguages: asStringArray(record.translationLanguages),
    pinned: record.pinned === true,
    pinnedAt: typeof record.pinnedAt === "string" ? record.pinnedAt : undefined,
    transcript: record.transcript,
    result,
  };
};

const readGuestEncounterRecords = (guestId: string): GuestEncounterRecord[] => {
  try {
    const rawRecords = localStorage.getItem(getGuestRecordsKey(guestId));

    if (!rawRecords) {
      return [];
    }

    const parsedRecords = JSON.parse(rawRecords) as unknown;

    return Array.isArray(parsedRecords)
      ? parsedRecords
          .map(toGuestEncounterRecord)
          .filter((record): record is GuestEncounterRecord => record !== null)
      : [];
  } catch {
    return [];
  }
};

const writeGuestEncounterRecords = (
  guestId: string,
  records: GuestEncounterRecord[],
) => {
  localStorage.setItem(getGuestRecordsKey(guestId), JSON.stringify(records));
};

const parsePatientAge = (age: string) => {
  const parsedAge = Number.parseInt(age, 10);

  return Number.isFinite(parsedAge) && parsedAge >= 0 && parsedAge <= 130
    ? parsedAge
    : undefined;
};

const normalizePatientName = (name: string) =>
  name.replace(/\s+/g, " ").trim() || "Unknown patient";

const normalizePatientProfileKey = (name: string) =>
  normalizePatientName(name).toLowerCase();

const toGuestPatientProfile = (value: unknown): PatientProfile | null => {
  const record = asRecord(value);

  if (
    !record ||
    typeof record.profileId !== "string" ||
    typeof record.name !== "string" ||
    typeof record.createdAt !== "string" ||
    typeof record.updatedAt !== "string"
  ) {
    return null;
  }

  return {
    profileId: record.profileId,
    patientId: typeof record.patientId === "string" ? record.patientId : undefined,
    name: record.name,
    age: typeof record.age === "number" ? record.age : undefined,
    gender: typeof record.gender === "string" ? record.gender : undefined,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
};

const readGuestPatientProfiles = (guestId: string): PatientProfile[] => {
  try {
    const rawProfiles = localStorage.getItem(getGuestPatientProfilesKey(guestId));

    if (!rawProfiles) {
      return [];
    }

    const parsedProfiles = JSON.parse(rawProfiles) as unknown;

    return Array.isArray(parsedProfiles)
      ? parsedProfiles
          .map(toGuestPatientProfile)
          .filter((profile): profile is PatientProfile => profile !== null)
      : [];
  } catch {
    return [];
  }
};

const writeGuestPatientProfiles = (
  guestId: string,
  profiles: PatientProfile[],
) => {
  localStorage.setItem(getGuestPatientProfilesKey(guestId), JSON.stringify(profiles));
};

const upsertGuestPatientProfile = (
  guestId: string,
  patientDraft: Pick<
    PatientDraft,
    "patientProfileId" | "patientId" | "name" | "age" | "gender"
  >,
) => {
  const profiles = readGuestPatientProfiles(guestId);
  const patientId = patientDraft.patientId.trim() || undefined;
  const patientName = normalizePatientName(patientDraft.name);
  const patientAge = parsePatientAge(patientDraft.age);
  const patientGender = patientDraft.gender.trim() || undefined;
  const existingProfile =
    (patientDraft.patientProfileId
      ? profiles.find((profile) => profile.profileId === patientDraft.patientProfileId)
      : undefined) ??
    (patientId
      ? profiles.find(
          (profile) =>
            normalizeFilterKey(profile.patientId) === normalizeFilterKey(patientId),
        )
      : undefined) ??
    profiles.find(
      (profile) =>
        normalizePatientProfileKey(profile.name) ===
        normalizePatientProfileKey(patientName),
    );
  const now = new Date().toISOString();
  const profile: PatientProfile = {
    profileId: existingProfile?.profileId ?? `guest_patient_${crypto.randomUUID()}`,
    patientId: patientId ?? existingProfile?.patientId,
    name: patientName,
    age: patientAge ?? existingProfile?.age,
    gender: patientGender ?? existingProfile?.gender,
    createdAt: existingProfile?.createdAt ?? now,
    updatedAt: now,
  };
  const nextProfiles = upsertPatientProfileList(profiles, profile);

  writeGuestPatientProfiles(guestId, nextProfiles);

  return profile;
};

const getVisitDateTimestamp = (visitDate: string) => {
  const trimmedDate = visitDate.trim();

  if (!trimmedDate) {
    return undefined;
  }

  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmedDate)) {
    return `${trimmedDate}T00:00:00.000Z`;
  }

  const date = new Date(trimmedDate);

  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
};

const makeGuestTitle = (
  noteJson: Record<string, unknown>,
  transcript: string,
  explicitTitle = "",
) => {
  const title = (
    explicitTitle ||
    getStringValue(noteJson.title) ||
    getStringValue(noteJson.visit_summary) ||
    transcript ||
    "Clinic note"
  )
    .replace(/\s+/g, " ")
    .trim();

  return title || "Clinic note";
};

const getGuestRecordingCount = (noteJson: Record<string, unknown>) =>
  Array.isArray(noteJson.recordings) ? noteJson.recordings.length : 0;

const saveGuestEncounterRecord = (
  guestId: string,
  input: {
    encounterId?: string;
    patientDraft: PatientDraft;
    noteJson: Record<string, unknown>;
    transcript: string;
    title?: string;
  },
) => {
  const records = readGuestEncounterRecords(guestId);
  const existingRecord = input.encounterId
    ? records.find((record) => record.id === input.encounterId)
    : null;
  const now = new Date().toISOString();
  const noteJson = input.noteJson;
  const patientMetadata = asRecord(noteJson.patient) ?? {};
  const encounterMetadata = asRecord(noteJson.encounter) ?? {};
  const soap = asRecord(noteJson.soap) ?? {};
  const patientProfile = upsertGuestPatientProfile(guestId, input.patientDraft);
  const patientName = patientProfile.name;
  const patientId = patientProfile.patientId;
  const patientAge = patientProfile.age;
  const patientGender = patientProfile.gender;
  const diagnosis =
    input.patientDraft.diagnosis.trim() ||
    getStringValue(encounterMetadata.diagnosis) ||
    getStringValue(soap.assessment) ||
    undefined;
  const visitDate = getVisitDateTimestamp(input.patientDraft.visitDate);
  const title = makeGuestTitle(noteJson, input.transcript, input.title);
  const noteId =
    getStringValue(noteJson.note_id) ||
    existingRecord?.legacyNoteId ||
    `guest_note_${crypto.randomUUID()}`;
  const result: Record<string, unknown> = {
    ...noteJson,
    note_id: noteId,
    title,
    pinned: existingRecord?.pinned === true,
    pinned_at: existingRecord?.pinnedAt,
    patient: {
      ...patientMetadata,
      patient_profile_id: patientProfile.profileId,
      patient_id: patientId ?? "",
      patient_identifier: patientId ?? "",
      name: patientName,
      age: patientAge ?? null,
      gender: patientGender ?? "",
    },
    encounter: {
      ...encounterMetadata,
      visit_date: input.patientDraft.visitDate.trim(),
      diagnosis: diagnosis ?? "",
    },
  };
  const record: GuestEncounterRecord = {
    id: existingRecord?.id ?? `guest_encounter_${crypto.randomUUID()}`,
    legacyNoteId: noteId,
    title,
    createdAt: existingRecord?.createdAt ?? now,
    updatedAt: now,
    patientProfileId: patientProfile.profileId,
    patientId,
    patientName,
    patientAge,
    patientGender,
    diagnosis,
    visitDate,
    languageDetected: getStringValue(result.language_detected) || undefined,
    providerUsed: getStringValue(result.provider_used) || undefined,
    recordingCount: getGuestRecordingCount(result),
    translationLanguages: asStringArray(result.translation_languages),
    pinned: existingRecord?.pinned === true,
    pinnedAt: existingRecord?.pinnedAt,
    transcript: input.transcript,
    result,
  };
  const nextRecords = sortSavedNotes([
    record,
    ...records.filter((existing) => existing.id !== record.id),
  ]) as GuestEncounterRecord[];

  writeGuestEncounterRecords(guestId, nextRecords);

  return record;
};

const updateGuestEncounterSummary = (
  guestId: string,
  encounterId: string,
  updates: { title?: string; pinned?: boolean },
) => {
  const records = readGuestEncounterRecords(guestId);
  const existingRecord = records.find((record) => record.id === encounterId);

  if (!existingRecord) {
    throw new Error("Saved note not found.");
  }

  const now = new Date().toISOString();
  const nextPinned =
    typeof updates.pinned === "boolean" ? updates.pinned : existingRecord.pinned;
  const nextPinnedAt =
    typeof updates.pinned === "boolean"
      ? updates.pinned
        ? existingRecord.pinnedAt ?? now
        : undefined
      : existingRecord.pinnedAt;
  const nextTitle = updates.title ?? existingRecord.title;
  const updatedRecord: GuestEncounterRecord = {
    ...existingRecord,
    title: nextTitle,
    updatedAt: now,
    pinned: nextPinned,
    pinnedAt: nextPinnedAt,
    result: {
      ...existingRecord.result,
      title: nextTitle,
      pinned: nextPinned,
      pinned_at: nextPinnedAt,
    },
  };
  const nextRecords = sortSavedNotes([
    updatedRecord,
    ...records.filter((record) => record.id !== encounterId),
  ]) as GuestEncounterRecord[];

  writeGuestEncounterRecords(guestId, nextRecords);

  return updatedRecord;
};

const deleteGuestEncounterRecord = (guestId: string, encounterId: string) => {
  writeGuestEncounterRecords(
    guestId,
    readGuestEncounterRecords(guestId).filter(
      (record) => record.id !== encounterId,
    ),
  );
};

const syncGuestRecordsToAccount = async (guestId: string) => {
  const records = readGuestEncounterRecords(guestId);
  const profiles = readGuestPatientProfiles(guestId);

  if (records.length === 0 && profiles.length === 0) {
    clearPendingGuestSync();
    return 0;
  }

  for (const profile of profiles) {
    await savePatientProfile({
      patientId: profile.patientId ?? "",
      name: profile.name,
      age: profile.age === undefined ? "" : String(profile.age),
      gender: profile.gender ?? "",
    });
  }

  for (const record of records) {
    await saveEncounterRecord({
      patientDraft: {
        patientId: record.patientId ?? "",
        name: record.patientName,
        age: record.patientAge === undefined ? "" : String(record.patientAge),
        gender: record.patientGender ?? "",
        visitDate: getDateInputValue(record.visitDate),
        diagnosis: record.diagnosis ?? "",
      },
      noteJson: record.result,
      transcript: record.transcript,
      title: record.title,
    });
  }

  localStorage.removeItem(getGuestRecordsKey(guestId));
  localStorage.removeItem(getGuestPatientProfilesKey(guestId));
  clearPendingGuestSync();

  return records.length + profiles.length;
};

const getTranslationLanguages = (note: NoteResult | null) =>
  asStringArray(note?.translation_languages);

const getLanguageKey = (language: string) => language.trim().toLowerCase();

const getOriginalNoteLanguage = (note: NoteResult | null) =>
  getStringValue(note?.language_detected);

const uniqueLanguages = (languages: string[]) => {
  const seen = new Set<string>();
  const result: string[] = [];

  languages.forEach((language) => {
    const trimmedLanguage = language.trim();
    const key = getLanguageKey(trimmedLanguage);

    if (!key || seen.has(key)) {
      return;
    }

    seen.add(key);
    result.push(trimmedLanguage);
  });

  return result;
};

const formatDate = (value: string) => {
  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return value;
  }

  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
};

const splitNumberedItems = (value: unknown) => {
  const text = getStringValue(value);

  if (!text) {
    return [];
  }

  const matches = [...text.matchAll(/(?:^|\s)(\d+)\.\s+/g)];

  if (matches.length < 2) {
    return [];
  }

  return matches
    .map((match, index) => {
      const start = (match.index ?? 0) + match[0].length;
      const end =
        index + 1 < matches.length ? (matches[index + 1].index ?? text.length) : text.length;

      return text.slice(start, end).trim();
    })
    .filter(Boolean);
};

const splitClinicalItems = (value: unknown) => {
  const text = getStringValue(value);

  if (!text) {
    return [];
  }

  const numberedItems = splitNumberedItems(text);

  if (numberedItems.length > 0) {
    return numberedItems;
  }

  const newlineItems = text
    .split(/\n+/)
    .map((item) => item.trim())
    .filter(Boolean);

  if (newlineItems.length > 1) {
    return newlineItems;
  }

  const sentenceItems = text
    .split(/(?<=[.!?])\s+(?=[A-Z0-9])/)
    .map((item) => item.trim())
    .filter(Boolean);

  return sentenceItems.length > 1 ? sentenceItems : [text];
};

const parseJsonResponse = async (response: Response, invalidMessage: string) => {
  const responseText = await response.text();

  try {
    return JSON.parse(responseText) as unknown;
  } catch {
    throw new Error(invalidMessage);
  }
};

const renderList = (items: unknown) => {
  const values = asStringArray(items);

  if (values.length === 0) {
    return <p className="text-sm text-zinc-500">None documented.</p>;
  }

  return (
    <ul className="space-y-2 text-sm leading-6 text-zinc-700">
      {values.map((item, index) => (
        <li key={`${item}-${index}`} className="rounded-lg bg-zinc-50 px-3 py-2">
          {item}
        </li>
      ))}
    </ul>
  );
};

const renderBulletText = (value: unknown) => {
  const items = splitClinicalItems(value);

  if (items.length === 0) {
    return <p className="text-sm text-zinc-500">Not documented.</p>;
  }

  return (
    <ul className="mt-2 list-disc space-y-2 pl-5 text-sm leading-6 text-zinc-700">
      {items.map((item, index) => (
        <li key={`${item}-${index}`}>{item}</li>
      ))}
    </ul>
  );
};

const renderNumberedText = (value: unknown) => {
  const items = splitNumberedItems(value);
  const fallbackItems = items.length > 0 ? items : splitClinicalItems(value);

  if (fallbackItems.length === 0) {
    return <p className="text-sm text-zinc-500">Not documented.</p>;
  }

  return (
    <ol className="mt-2 list-decimal space-y-2 pl-5 text-sm leading-6 text-zinc-700">
      {fallbackItems.map((item, index) => (
        <li key={`${item}-${index}`}>{item}</li>
      ))}
    </ol>
  );
};

const escapeHtml = (value: string) =>
  value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

const printableParagraph = (value: unknown) =>
  `<p>${escapeHtml(asText(value)).replace(/\n/g, "<br />")}</p>`;

const printableList = (
  items: string[],
  options: { ordered?: boolean; emptyText?: string } = {},
) => {
  if (items.length === 0) {
    return `<p class="muted">${escapeHtml(options.emptyText ?? "Not documented.")}</p>`;
  }

  const tag = options.ordered ? "ol" : "ul";
  const listItems = items
    .map((item) => `<li>${escapeHtml(item)}</li>`)
    .join("");

  return `<${tag}>${listItems}</${tag}>`;
};

const printableArrayList = (items: unknown) =>
  printableList(asStringArray(items), { emptyText: "None documented." });

const printableField = (label: string, value: string) => `
  <div class="field">
    <dt>${escapeHtml(label)}</dt>
    <dd>${escapeHtml(value || "Not documented.")}</dd>
  </div>
`;

const getPrintableDate = (value: string) => {
  if (!value) {
    return "";
  }

  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return value;
  }

  return formatDate(value);
};

const buildPrintableNoteHtml = ({
  note,
  patientDraft,
  heading,
  noteLabel,
}: {
  note: NoteResult;
  patientDraft: PatientDraft;
  heading: string;
  noteLabel: string;
}) => {
  const soap = note.soap ?? {};
  const extracted = note.extracted ?? {};
  const planItems = splitNumberedItems(soap.plan);
  const printablePlanItems =
    planItems.length > 0 ? planItems : splitClinicalItems(soap.plan);
  const exportedAt = new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date());

  return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <title>${escapeHtml(heading)} - ClinicScribe PDF</title>
    <style>
      @page {
        margin: 0.65in;
      }

      * {
        box-sizing: border-box;
      }

      body {
        margin: 0;
        color: #111827;
        font-family: Arial, Helvetica, sans-serif;
        font-size: 12px;
        line-height: 1.55;
      }

      header {
        border-bottom: 2px solid #111827;
        margin-bottom: 20px;
        padding-bottom: 14px;
      }

      h1 {
        font-size: 24px;
        line-height: 1.2;
        margin: 0 0 6px;
      }

      h2 {
        border-bottom: 1px solid #d4d4d8;
        font-size: 15px;
        margin: 22px 0 10px;
        padding-bottom: 5px;
        text-transform: uppercase;
      }

      h3 {
        font-size: 13px;
        margin: 0 0 6px;
      }

      p {
        margin: 0;
        white-space: pre-wrap;
      }

      ul,
      ol {
        margin: 0;
        padding-left: 20px;
      }

      li + li {
        margin-top: 4px;
      }

      .meta {
        color: #52525b;
        font-size: 11px;
      }

      .grid {
        display: grid;
        gap: 8px 18px;
        grid-template-columns: repeat(2, minmax(0, 1fr));
      }

      .field {
        border-bottom: 1px solid #e4e4e7;
        padding-bottom: 6px;
      }

      dt {
        color: #52525b;
        font-size: 10px;
        font-weight: 700;
        letter-spacing: 0.04em;
        margin-bottom: 2px;
        text-transform: uppercase;
      }

      dd {
        margin: 0;
      }

      .soap-grid,
      .extracted-grid {
        display: grid;
        gap: 14px 20px;
        grid-template-columns: repeat(2, minmax(0, 1fr));
      }

      .full {
        grid-column: 1 / -1;
      }

      .muted {
        color: #71717a;
        font-style: italic;
      }

      footer {
        border-top: 1px solid #d4d4d8;
        color: #71717a;
        font-size: 10px;
        margin-top: 28px;
        padding-top: 8px;
      }

      @media print {
        button {
          display: none;
        }

        section {
          break-inside: avoid;
        }
      }
    </style>
  </head>
  <body>
    <header>
      <p class="meta">ClinicScribe clinical note export</p>
      <h1>${escapeHtml(heading)}</h1>
      <p class="meta">${escapeHtml(noteLabel)} | Exported ${escapeHtml(exportedAt)}</p>
    </header>

    <section>
      <h2>Patient and Visit</h2>
      <dl class="grid">
        ${printableField("Patient name", patientDraft.name)}
        ${printableField("Patient ID", patientDraft.patientId)}
        ${printableField("Age", patientDraft.age)}
        ${printableField("Gender", patientDraft.gender)}
        ${printableField("Visit date", getPrintableDate(patientDraft.visitDate))}
        ${printableField("Diagnosis", patientDraft.diagnosis)}
      </dl>
    </section>

    <section>
      <h2>SOAP</h2>
      <div class="soap-grid">
        <div>
          <h3>Subjective</h3>
          ${printableList(splitClinicalItems(soap.subjective))}
        </div>
        <div>
          <h3>Objective</h3>
          ${printableList(splitClinicalItems(soap.objective))}
        </div>
        <div>
          <h3>Assessment</h3>
          ${printableList(splitClinicalItems(soap.assessment))}
        </div>
        <div>
          <h3>Plan</h3>
          ${printableList(printablePlanItems, { ordered: true })}
        </div>
      </div>
    </section>

    <section>
      <h2>Visit Summary</h2>
      ${printableParagraph(note.visit_summary)}
    </section>

    <section>
      <h2>Extracted Data</h2>
      <div class="extracted-grid">
        <div>
          <h3>Symptoms</h3>
          ${printableArrayList(extracted.symptoms)}
        </div>
        <div>
          <h3>Medications</h3>
          ${printableArrayList(extracted.medications)}
        </div>
        <div>
          <h3>Follow-up Plan</h3>
          ${printableArrayList(extracted.follow_up_plan)}
        </div>
        <div>
          <h3>Red Flags</h3>
          ${printableArrayList(extracted.red_flags)}
        </div>
        <div class="full">
          <h3>Uncertainties</h3>
          ${printableArrayList(note.uncertainties)}
        </div>
      </div>
    </section>

    <section>
      <h2>Discharge Instructions</h2>
      ${printableParagraph(note.discharge_instructions)}
    </section>

    <footer>
      Transcript, recordings, and chat history are intentionally excluded from this PDF export.
    </footer>
  </body>
</html>`;
};

function App() {
  const [currentUser, setCurrentUser] = useState<CurrentUser | null>(null);
  const [isCheckingAuth, setIsCheckingAuth] = useState(true);
  const [authMode, setAuthMode] = useState<AuthMode>("login");
  const [authName, setAuthName] = useState("");
  const [authEmail, setAuthEmail] = useState("");
  const [authPassword, setAuthPassword] = useState("");
  const [authPasswordConfirmation, setAuthPasswordConfirmation] = useState("");
  const [showAuthPassword, setShowAuthPassword] = useState(false);
  const [showAuthPasswordConfirmation, setShowAuthPasswordConfirmation] =
    useState(false);
  const [authError, setAuthError] = useState("");
  const [isAuthSubmitting, setIsAuthSubmitting] = useState(false);
  const [isLoggingOut, setIsLoggingOut] = useState(false);
  const [transcript, setTranscript] = useState("");
  const [status, setStatus] = useState("Ready");
  const [error, setError] = useState("");
  const [isRecording, setIsRecording] = useState(false);
  const [isUploading, setIsUploading] = useState(false);
  const [noteResult, setNoteResult] = useState<NoteResult | null>(null);
  const [baseNoteResult, setBaseNoteResult] = useState<NoteResult | null>(null);
  const [currentNoteTitle, setCurrentNoteTitle] = useState("");
  const [currentNoteTranscript, setCurrentNoteTranscript] = useState("");
  const [currentEncounterId, setCurrentEncounterId] = useState("");
  const [patientDraft, setPatientDraft] = useState<PatientDraft>(() =>
    getPatientDraftFromNote(null),
  );
  const [isSavingPatientRecord, setIsSavingPatientRecord] = useState(false);
  const [patientRecordStatus, setPatientRecordStatus] = useState("");
  const [isSavingPatientProfile, setIsSavingPatientProfile] = useState(false);
  const [pendingRecordings, setPendingRecordings] = useState<NoteRecording[]>([]);
  const [currentNoteRecordings, setCurrentNoteRecordings] = useState<
    NoteRecording[]
  >([]);
  const [activeNoteLanguage, setActiveNoteLanguage] = useState("Original");
  const [activeView, setActiveView] = useState<AppView>(() =>
    getViewFromPathname(window.location.pathname),
  );
  const [savedNotes, setSavedNotes] = useState<SavedNoteSummary[]>([]);
  const [patientProfiles, setPatientProfiles] = useState<PatientProfile[]>([]);
  const [selectedPatientProfileId, setSelectedPatientProfileId] = useState(() =>
    getPatientProfileIdFromPathname(window.location.pathname),
  );
  const [isLoadingNotes, setIsLoadingNotes] = useState(false);
  const [vaultError, setVaultError] = useState("");
  const [dashboardSearch, setDashboardSearch] = useState("");
  const [dashboardSort, setDashboardSort] = useState<DashboardSort>("newest");
  const [dashboardFilters, setDashboardFilters] = useState<DashboardFilters>(
    EMPTY_DASHBOARD_FILTERS,
  );
  const [isDashboardFilterPanelOpen, setIsDashboardFilterPanelOpen] =
    useState(false);
  const [languageSearch, setLanguageSearch] = useState("");
  const [isLanguagePickerOpen, setIsLanguagePickerOpen] = useState(false);
  const [selectedTranslationLanguage, setSelectedTranslationLanguage] =
    useState("");
  const [isTranslating, setIsTranslating] = useState(false);
  const [translationStatus, setTranslationStatus] = useState("");
  const [showDebugPanel, setShowDebugPanel] = useState(false);
  const [noteError, setNoteError] = useState("");
  const [isNoteChatOpen, setIsNoteChatOpen] = useState(false);
  const [noteChatInput, setNoteChatInput] = useState("");
  const [noteChatMessages, setNoteChatMessages] = useState<NoteChatMessage[]>([]);
  const [selectedNoteText, setSelectedNoteText] = useState("");
  const [isEditingNoteWithAi, setIsEditingNoteWithAi] = useState(false);
  const [noteChatError, setNoteChatError] = useState("");
  const [isGeneratingNote, setIsGeneratingNote] = useState(false);
  const [hasHydratedAutosave, setHasHydratedAutosave] = useState(false);
  const [autosaveStatus, setAutosaveStatus] = useState("Autosave ready");

  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<BlobPart[]>([]);
  const suppressNextAutosaveRef = useRef(false);
  const lastPatientRecordAutosaveSignatureRef = useRef("");
  const noteContentRef = useRef<HTMLDivElement | null>(null);
  const noteChatMessagesEndRef = useRef<HTMLDivElement | null>(null);
  const isGuestMode = currentUser?.isGuest === true;
  const guestId = isGuestMode ? currentUser.id : "";

  const cleanupRecording = () => {
    mediaStreamRef.current?.getTracks().forEach((track) => track.stop());
    mediaStreamRef.current = null;
    mediaRecorderRef.current = null;
    chunksRef.current = [];
  };

  const resetNoteChat = () => {
    setIsNoteChatOpen(false);
    setNoteChatInput("");
    setNoteChatMessages([]);
    setSelectedNoteText("");
    setNoteChatError("");
    setIsEditingNoteWithAi(false);
  };

  const loadNoteChatHistory = (note: NoteResult | null) => {
    setNoteChatMessages(getNoteChatHistory(note));
    setNoteChatInput("");
    setSelectedNoteText("");
    setNoteChatError("");
    setIsEditingNoteWithAi(false);
  };

  const saveNoteChatHistory = (chatHistory: NoteChatMessage[]) => {
    const nextHistory = chatHistory.slice(-NOTE_CHAT_HISTORY_LIMIT);

    setNoteChatMessages(nextHistory);
    setBaseNoteResult((current) => withNoteChatHistory(current, nextHistory));
    setNoteResult((current) =>
      activeNoteLanguage === "Original"
        ? withNoteChatHistory(current, nextHistory)
        : current,
    );
  };

  const updateSelectedNoteText = () => {
    const selection = window.getSelection();
    const selectedText = selection?.toString().trim() ?? "";

    if (
      !selectedText ||
      !selection?.anchorNode ||
      !selection.focusNode ||
      !noteContentRef.current?.contains(selection.anchorNode) ||
      !noteContentRef.current.contains(selection.focusNode)
    ) {
      setSelectedNoteText("");
      return;
    }

    setSelectedNoteText(selectedText.replace(/\s+/g, " ").slice(0, 8000));
  };

  const enterGuestMode = () => {
    setGuestModeActive(true);
    setAuthError("");
    setCurrentUser(makeGuestUser());
    setStatus("Guest mode");
  };

  const startGuestAccountSync = (mode: AuthMode) => {
    if (guestId) {
      setPendingGuestSync(guestId);
    }

    setGuestModeActive(false);
    setAuthMode(mode);
    setAuthError(
      mode === "signup"
        ? "Create an account to sync your guest notes."
        : "Sign in to sync your guest notes.",
    );
    setCurrentUser(null);
  };

  const completeSupabaseAuth = async (user: User) => {
    const nextUser = toCurrentUser(user);
    const pendingGuestId = getPendingGuestSync();

    setGuestModeActive(false);

    if (pendingGuestId) {
      try {
        const syncedCount = await syncGuestRecordsToAccount(pendingGuestId);

        if (syncedCount > 0) {
          setStatus(
            `Synced ${syncedCount} guest item${syncedCount === 1 ? "" : "s"}`,
          );
          setNoteResult(null);
          setBaseNoteResult(null);
          resetNoteChat();
          setCurrentNoteTranscript("");
          setCurrentNoteRecordings([]);
          setCurrentNoteTitle("");
          setCurrentEncounterId("");
          setPatientDraft(getPatientDraftFromNote(null));
          setPatientRecordStatus("Guest notes synced to your account.");
          setActiveNoteLanguage("Original");
          setSelectedTranslationLanguage("");
          window.history.pushState(null, "", VIEW_PATHS.dashboard);
          setActiveView("dashboard");
        }
      } catch (syncError) {
        setVaultError(
          syncError instanceof Error
            ? `Signed in, but guest notes were not synced: ${syncError.message}`
            : "Signed in, but guest notes were not synced.",
        );
      }
    }

    setCurrentUser(nextUser);
  };

  const handleAuthSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setAuthError("");

    if (authMode === "signup" && authPassword !== authPasswordConfirmation) {
      setAuthError("Passwords do not match.");
      return;
    }

    setIsAuthSubmitting(true);

    try {
      const email = authEmail.trim();
      const password = authPassword;

      if (authMode === "signup") {
        const { data, error: signUpError } = await supabase.auth.signUp({
          email,
          password,
          options: {
            data: {
              name: authName.trim() || email,
            },
          },
        });

        if (signUpError) {
          throw signUpError;
        }

        if (!data.session || !data.user) {
          setAuthMode("login");
          setAuthPassword("");
          setAuthPasswordConfirmation("");
          setAuthError("Account created. Confirm your email, then sign in.");
          return;
        }

        await completeSupabaseAuth(data.user);
      } else {
        const { data, error: signInError } =
          await supabase.auth.signInWithPassword({
            email,
            password,
          });

        if (signInError || !data.user) {
          throw signInError ?? new Error("Unable to sign in.");
        }

        await completeSupabaseAuth(data.user);
      }

      setAuthPassword("");
      setAuthPasswordConfirmation("");
      setAuthError("");
    } catch (submitError) {
      setAuthError(
        submitError instanceof Error
          ? submitError.message
          : "Authentication failed.",
      );
    } finally {
      setIsAuthSubmitting(false);
    }
  };

  const handleLogout = async () => {
    setError("");
    setIsLoggingOut(true);

    try {
      if (isGuestMode) {
        setGuestModeActive(false);
      } else {
        const { error: signOutError } = await supabase.auth.signOut();

        if (signOutError) {
          throw signOutError;
        }
      }

      cleanupRecording();
      setCurrentUser(null);
      setTranscript("");
      setNoteResult(null);
      setBaseNoteResult(null);
      resetNoteChat();
      setCurrentNoteTranscript("");
      setCurrentEncounterId("");
      setPatientDraft(getPatientDraftFromNote(null));
      setPatientRecordStatus("");
      setPendingRecordings([]);
      setCurrentNoteRecordings([]);
      setSavedNotes([]);
      setPatientProfiles([]);
      setSelectedPatientProfileId("");
      setSelectedTranslationLanguage("");
      setNoteError("");
      setHasHydratedAutosave(false);
      setAutosaveStatus("Autosave ready");
      setStatus("Ready");
    } catch (logoutError) {
      setError(
        logoutError instanceof Error ? logoutError.message : "Unable to sign out.",
      );
    } finally {
      setIsLoggingOut(false);
    }
  };

  const loadSavedNotes = async () => {
    setIsLoadingNotes(true);
    setVaultError("");

    try {
      const notes = isGuestMode
        ? sortSavedNotes(
            readGuestEncounterRecords(guestId).map(toSavedNoteSummary),
          )
        : sortSavedNotes(
            (await listEncounterSummaries()).map(toSavedNoteSummary),
          );

      setSavedNotes(notes);
      return notes;
    } catch (notesError) {
      setVaultError(
        notesError instanceof Error ? notesError.message : "Unable to load notes.",
      );
      return [];
    } finally {
      setIsLoadingNotes(false);
    }
  };

  const loadPatientProfiles = async () => {
    setVaultError("");

    try {
      const profiles = isGuestMode
        ? readGuestPatientProfiles(guestId)
        : await listPatientProfiles();

      setPatientProfiles(profiles);
      return profiles;
    } catch (profileError) {
      setVaultError(
        profileError instanceof Error
          ? profileError.message
          : "Unable to load patient profiles.",
      );
      return [];
    }
  };

  const navigateToView = (view: AppView) => {
    const nextPath = VIEW_PATHS[view];

    if (window.location.pathname !== nextPath) {
      window.history.pushState(null, "", nextPath);
    }

    setActiveView(view);

    if (view === "dashboard") {
      void loadSavedNotes();
      void loadPatientProfiles();
    }
  };

  const navigateToPatientProfile = (profileId: string) => {
    if (!profileId) {
      return;
    }

    const nextPath = getPatientProfilePath(profileId);

    if (window.location.pathname !== nextPath) {
      window.history.pushState(null, "", nextPath);
    }

    setSelectedPatientProfileId(profileId);
    setActiveView("patient");
    void loadSavedNotes();
    void loadPatientProfiles();
  };

  const openSavedNote = async (noteId: string) => {
    setVaultError("");

    try {
      const note = isGuestMode
        ? readGuestEncounterRecords(guestId).find((record) => record.id === noteId)
        : await getEncounterDetail(noteId);

      if (!note) {
        throw new Error("Saved note not found.");
      }

      const noteResultDraft = note.result as NoteResult;
      const loadedPatientDraft = getPatientDraftFromNote(noteResultDraft);
      const nextPatientDraft = {
        ...loadedPatientDraft,
        patientProfileId: note.patientProfileId ?? loadedPatientDraft.patientProfileId,
        patientId: note.patientId ?? loadedPatientDraft.patientId,
        name: note.patientName,
        age: note.patientAge === undefined ? "" : String(note.patientAge),
        gender: note.patientGender ?? "",
        visitDate: getDateInputValue(note.visitDate),
        diagnosis: note.diagnosis ?? "",
      };

      setBaseNoteResult(noteResultDraft);
      setNoteResult(noteResultDraft);
      loadNoteChatHistory(noteResultDraft);
      setCurrentNoteTitle(note.title);
      setCurrentNoteTranscript(note.transcript);
      setCurrentEncounterId(note.id);
      setPatientDraft(nextPatientDraft);
      lastPatientRecordAutosaveSignatureRef.current = JSON.stringify({
        note: toNoteRecord(noteResultDraft),
        patientDraft: nextPatientDraft,
        title: note.title,
        transcript: note.transcript,
      });
      setPatientRecordStatus("Patient record loaded.");
      setPendingRecordings([]);
      setCurrentNoteRecordings(getNoteRecordings(noteResultDraft));
      setActiveNoteLanguage("Original");
      setSelectedTranslationLanguage("");
      setTranslationStatus("");
      setNoteError("");
      navigateToView("note");
    } catch (openError) {
      setVaultError(
        openError instanceof Error ? openError.message : "Unable to open note.",
      );
    }
  };

  const updateSavedNote = async (
    noteId: string,
    updates: { title?: string; pinned?: boolean },
  ) => {
    setVaultError("");

    try {
      const updatedNote = toSavedNoteSummary(
        isGuestMode
          ? updateGuestEncounterSummary(guestId, noteId, updates)
          : await updateEncounterSummary(noteId, updates),
      );

      setSavedNotes((currentNotes) =>
        upsertSavedNoteSummary(currentNotes, updatedNote),
      );

      if (currentEncounterId === noteId) {
        if (updates.title) {
          setCurrentNoteTitle(updates.title);
        }

        setBaseNoteResult((current) =>
          current
            ? {
                ...current,
                title: updatedNote.title,
                pinned: updatedNote.pinned,
                pinned_at: updatedNote.pinnedAt,
              }
            : current,
        );
        setNoteResult((current) =>
          current
            ? {
                ...current,
                title: updatedNote.title,
                pinned: updatedNote.pinned,
                pinned_at: updatedNote.pinnedAt,
              }
            : current,
        );
      }
    } catch (updateError) {
      setVaultError(
        updateError instanceof Error
          ? updateError.message
          : "Unable to update saved note.",
      );
    }
  };

  const renameSavedNote = (note: SavedNoteSummary) => {
    const nextTitle = window.prompt("Rename note", note.title)?.trim();

    if (!nextTitle || nextTitle === note.title) {
      return;
    }

    void updateSavedNote(note.id, { title: nextTitle });
  };

  const togglePinnedNote = (note: SavedNoteSummary) => {
    void updateSavedNote(note.id, { pinned: !note.pinned });
  };

  const deleteSavedNote = async (note: SavedNoteSummary) => {
    if (!window.confirm(`Delete "${note.title}"?`)) {
      return;
    }

    setVaultError("");

    try {
      if (isGuestMode) {
        deleteGuestEncounterRecord(guestId, note.id);
      } else {
        await deleteEncounterRecord(note.id);
      }

      setSavedNotes((currentNotes) =>
        currentNotes.filter((savedNote) => savedNote.id !== note.id),
      );

      if (currentEncounterId === note.id) {
        setNoteResult(null);
        setBaseNoteResult(null);
        resetNoteChat();
        setCurrentNoteRecordings([]);
        setCurrentNoteTranscript("");
        setCurrentNoteTitle("");
        setCurrentEncounterId("");
        setPatientDraft(getPatientDraftFromNote(null));
        setPatientRecordStatus("");
        navigateToView("dashboard");
      }
    } catch (deleteError) {
      setVaultError(
        deleteError instanceof Error
          ? deleteError.message
          : "Unable to delete saved note.",
      );
    }
  };

  const getPatientRecordAutosaveSignature = (source: NoteResult | null) =>
    JSON.stringify({
      note: toNoteRecord(source),
      patientDraft,
      title: currentNoteTitle,
      transcript: currentNoteTranscript,
    });

  const showOriginalNote = (language = getOriginalNoteLanguage(baseNoteResult)) => {
    if (!baseNoteResult) {
      return;
    }

    setNoteResult(baseNoteResult);
    setActiveNoteLanguage("Original");
    setTranslationStatus(
      language ? `Showing saved original ${language} note.` : "Showing saved original note.",
    );
  };

  const selectTranslationLanguage = (language: string) => {
    setSelectedTranslationLanguage(language);
    setIsLanguagePickerOpen(false);
    setLanguageSearch("");
    setTranslationStatus("");
  };

  const translateSelectedLanguage = () => {
    if (!selectedTranslationLanguage) {
      setNoteError("Choose a language before translating.");
      return;
    }

    const originalLanguage = getOriginalNoteLanguage(baseNoteResult);

    if (
      originalLanguage &&
      getLanguageKey(selectedTranslationLanguage) === getLanguageKey(originalLanguage)
    ) {
      showOriginalNote(originalLanguage);
      return;
    }

    void translateNote(selectedTranslationLanguage);
  };

  const translateNote = async (language: string, force = false) => {
    const noteId = getNoteId(baseNoteResult ?? noteResult);

    if (!noteId) {
      setNoteError("Generate or open a saved note before translating.");
      return;
    }

    setIsTranslating(true);
    setIsLanguagePickerOpen(false);
    setNoteError("");
    setTranslationStatus("");

    try {
      const response = await apiFetch("/api/translate-note", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          noteId,
          language,
          force,
          ...(isGuestMode
            ? {
                note: toNoteRecord(baseNoteResult ?? noteResult),
                title: currentNoteTitle,
              }
            : {}),
        }),
      }, isGuestMode ? { guestId } : {});
      const responseJson = (await parseJsonResponse(
        response,
        "The translation endpoint returned invalid JSON.",
      )) as TranslateResponse;

      if (!response.ok || !responseJson.result || !responseJson.language) {
        throw new Error(getErrorMessage(responseJson, "Unable to translate note."));
      }

      const nextTranslationLanguages = getTranslationLanguages(responseJson.result);
      const nextBaseNoteResult = baseNoteResult
        ? {
            ...baseNoteResult,
            translation_languages: nextTranslationLanguages,
          }
        : responseJson.result;

      setNoteResult(responseJson.result);
      setBaseNoteResult(nextBaseNoteResult);
      setCurrentNoteTitle(responseJson.title ?? currentNoteTitle);
      setActiveNoteLanguage(responseJson.language);
      setSelectedTranslationLanguage(responseJson.language);
      setTranslationStatus(
        responseJson.cached
          ? `Loaded saved ${responseJson.language} translation.`
          : `Translated note to ${responseJson.language}.`,
      );
      setIsLanguagePickerOpen(false);
      setLanguageSearch("");

      if (currentEncounterId) {
        const savedEncounter = isGuestMode
          ? saveGuestEncounterRecord(guestId, {
              encounterId: currentEncounterId,
              patientDraft,
              noteJson: toNoteRecord(nextBaseNoteResult),
              transcript: currentNoteTranscript,
              title: responseJson.title ?? currentNoteTitle,
            })
          : await saveEncounterRecord({
              encounterId: currentEncounterId,
              patientDraft,
              noteJson: toNoteRecord(nextBaseNoteResult),
              transcript: currentNoteTranscript,
              title: responseJson.title ?? currentNoteTitle,
            });

        setSavedNotes((currentNotes) =>
          upsertSavedNoteSummary(currentNotes, toSavedNoteSummary(savedEncounter)),
        );
      }

      void loadSavedNotes();
    } catch (translationError) {
      setNoteError(
        translationError instanceof Error
          ? translationError.message
          : "Unable to translate note.",
      );
    } finally {
      setIsTranslating(false);
    }
  };

  const clearNoteChatHistory = () => {
    if (!baseNoteResult && !noteResult) {
      return;
    }

    if (
      noteChatMessages.length > 0 &&
      !window.confirm("Clear ClinicScribe AI chat history for this note?")
    ) {
      return;
    }

    saveNoteChatHistory([]);
    setNoteChatInput("");
    setSelectedNoteText("");
    setNoteChatError("");
    setPatientRecordStatus("Chat history cleared. Autosave will update this note.");
  };

  const sendNoteChatMessage = async () => {
    const source = baseNoteResult ?? noteResult;
    const message = noteChatInput.trim();

    if (!source) {
      setNoteChatError("Open or generate a note before chatting.");
      return;
    }

    if (!message) {
      return;
    }

    const selectedText = selectedNoteText.trim();
    const userMessage: NoteChatMessage = {
      id: createNoteChatMessageId(),
      role: "user",
      content: message,
      selectedText: selectedText || undefined,
      createdAt: new Date().toISOString(),
    };
    const historyWithUserMessage = [
      ...noteChatMessages,
      userMessage,
    ].slice(-NOTE_CHAT_HISTORY_LIMIT);

    saveNoteChatHistory(historyWithUserMessage);
    setNoteChatInput("");
    setNoteChatError("");
    setIsEditingNoteWithAi(true);

    try {
      const response = await apiFetch("/api/edit-note", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          note: toNoteRecord(source),
          message,
          selectedText,
          chatHistory: historyWithUserMessage.slice(-12),
        }),
      }, isGuestMode ? { guestId } : {});
      const responseJson = (await parseJsonResponse(
        response,
        "The note editor endpoint returned invalid JSON.",
      )) as EditNoteResponse;

      if (!response.ok || !responseJson.result) {
        throw new Error(getErrorMessage(responseJson, "Unable to edit note."));
      }

      const assistantMessage: NoteChatMessage = {
        id: createNoteChatMessageId(),
        role: "assistant",
        content:
          responseJson.message ||
          "I'm here. Tell me what you'd like to review or change in this note.",
        createdAt: new Date().toISOString(),
      };
      const nextHistory = [
        ...historyWithUserMessage,
        assistantMessage,
      ].slice(-NOTE_CHAT_HISTORY_LIMIT);
      const noteChanged = responseJson.changed !== false;
      const responseLanguages = getTranslationLanguages(responseJson.result);
      const editedNote: NoteResult = {
        ...source,
        ...responseJson.result,
        note_id: getNoteId(responseJson.result) || getNoteId(source),
        title:
          getStringValue(responseJson.result.title) ||
          currentNoteTitle ||
          getStringValue(source.title),
        saved_at: source.saved_at ?? responseJson.result.saved_at,
        recordings: source.recordings ?? responseJson.result.recordings,
        pinned: source.pinned ?? responseJson.result.pinned,
        pinned_at: source.pinned_at ?? responseJson.result.pinned_at,
        translation_languages:
          responseLanguages.length > 0
            ? responseJson.result.translation_languages
            : source.translation_languages,
        chat_history: nextHistory,
      };

      setNoteChatMessages(nextHistory);

      if (noteChanged) {
        setBaseNoteResult(editedNote);
        setNoteResult(editedNote);
        setCurrentNoteTitle(getStringValue(editedNote.title));
        setPatientDraft(getPatientDraftFromNote(editedNote));
        setActiveNoteLanguage("Original");
        setSelectedTranslationLanguage("");
        setTranslationStatus("ClinicScribe AI edited the original note.");
        setSelectedNoteText("");
        setPatientRecordStatus(
          "ClinicScribe AI updated the note. Autosave will save it.",
        );
      } else {
        setBaseNoteResult((current) => withNoteChatHistory(current, nextHistory));
        setNoteResult((current) =>
          activeNoteLanguage === "Original"
            ? withNoteChatHistory(current, nextHistory)
            : current,
        );
        setPatientRecordStatus(
          "ClinicScribe AI replied. Autosave will save this chat.",
        );
      }
    } catch (editError) {
      setNoteChatError(
        editError instanceof Error
          ? editError.message
          : "Unable to edit the note.",
      );
    } finally {
      setIsEditingNoteWithAi(false);
    }
  };

  const transcribeAudio = async (audioBlob: Blob) => {
    setIsUploading(true);
    setStatus("Uploading audio");

    try {
      const formData = new FormData();
      const file = new File([audioBlob], getAudioFileName(audioBlob.type), {
        type: audioBlob.type || "audio/webm",
      });

      formData.set("audio", file);

      const response = await apiFetch("/api/transcribe", {
        method: "POST",
        body: formData,
      }, isGuestMode ? { guestId } : {});

      const responseText = await response.text();
      let responseJson: unknown;

      try {
        responseJson = JSON.parse(responseText);
      } catch {
        throw new Error("The transcription endpoint returned invalid JSON.");
      }

      if (!response.ok) {
        const message =
          responseJson &&
          typeof responseJson === "object" &&
          "error" in responseJson &&
          typeof (responseJson as { error?: unknown }).error === "string"
            ? (responseJson as { error: string }).error
            : "Unable to transcribe audio.";

        throw new Error(message);
      }

      const formattedTranscript = formatTranscript(
        responseJson as TranscriptionResponse,
      );
      const recording = toRecording(
        (responseJson as TranscriptionResponse).recording,
        formattedTranscript,
      );

      if (!formattedTranscript) {
        throw new Error("No transcript text was returned.");
      }

      setError("");
      setTranscript((currentTranscript) =>
        currentTranscript.trim()
          ? `${currentTranscript.trimEnd()}\n\n${formattedTranscript}`
          : formattedTranscript,
      );
      setPendingRecordings((currentRecordings) =>
        recording ? [...currentRecordings, recording] : currentRecordings,
      );
      setNoteResult(null);
      setBaseNoteResult(null);
      resetNoteChat();
      setCurrentNoteRecordings([]);
      setCurrentNoteTranscript("");
      setCurrentNoteTitle("");
      setCurrentEncounterId("");
      setPatientDraft(getPatientDraftFromNote(null));
      setPatientRecordStatus("");
      setActiveNoteLanguage("Original");
      setSelectedTranslationLanguage("");
      setTranslationStatus("");
      setStatus("Transcript added");
    } catch (transcriptionError) {
      setError(
        transcriptionError instanceof Error
          ? transcriptionError.message
          : "Transcription failed.",
      );
      setStatus("Ready");
    } finally {
      setIsUploading(false);
      cleanupRecording();
    }
  };

  const startRecording = async () => {
    setError("");
    setNoteError("");

    if (!navigator.mediaDevices?.getUserMedia) {
      setError("Microphone recording is not supported in this browser.");
      return;
    }

    if (!window.MediaRecorder) {
      setError("MediaRecorder is not supported in this browser.");
      return;
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mimeType = getSupportedMimeType();
      const recorder = new MediaRecorder(
        stream,
        mimeType ? { mimeType } : undefined,
      );

      chunksRef.current = [];
      mediaStreamRef.current = stream;
      mediaRecorderRef.current = recorder;

      recorder.addEventListener("dataavailable", (event) => {
        if (event.data.size > 0) {
          chunksRef.current.push(event.data);
        }
      });

      recorder.addEventListener("stop", () => {
        const audioBlob = new Blob(chunksRef.current, {
          type: recorder.mimeType || mimeType || "audio/webm",
        });

        if (audioBlob.size === 0) {
          setError("No audio was captured.");
          setStatus("Ready");
          cleanupRecording();
          return;
        }

        void transcribeAudio(audioBlob);
      });

      recorder.start();
      setIsRecording(true);
      setStatus("Recording");
    } catch (recordingError) {
      setError(
        recordingError instanceof Error
          ? recordingError.message
          : "Unable to start recording.",
      );
      setStatus("Ready");
      cleanupRecording();
    }
  };

  const stopRecording = () => {
    const recorder = mediaRecorderRef.current;

    if (!recorder || recorder.state === "inactive") {
      setIsRecording(false);
      cleanupRecording();
      return;
    }

    setIsRecording(false);
    setStatus("Preparing audio");
    recorder.stop();
  };

  const handleButtonClick = () => {
    if (isRecording) {
      stopRecording();
      return;
    }

    void startRecording();
  };

  const clearCurrentTranscript = () => {
    cleanupRecording();
    clearAutosavedDraft(currentUser);
    suppressNextAutosaveRef.current = true;
    setIsRecording(false);
    setTranscript("");
    setPendingRecordings([]);
    setCurrentEncounterId("");
    setPatientDraft(getPatientDraftFromNote(null));
    setPatientRecordStatus("");
    setIsLanguagePickerOpen(false);
    setLanguageSearch("");
    setNoteError("");
    setError("");
    setStatus("Ready");
    setAutosaveStatus("Transcript cleared");
  };

  const generateNote = async () => {
    if (!transcript.trim()) {
      setNoteError("Add or record a transcript before generating a note.");
      return;
    }

    const transcriptForNote = transcript.trim();

    setIsGeneratingNote(true);
    setNoteError("");
    setNoteResult(null);
    resetNoteChat();

    try {
      const response = await apiFetch("/api/make-note", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          transcript: transcriptForNote,
          recordings: pendingRecordings.map((recording) => ({
            id: recording.id,
            transcript: recording.transcript,
          })),
        }),
      }, isGuestMode ? { guestId } : {});

      const responseText = await response.text();
      let responseJson: unknown;

      try {
        responseJson = JSON.parse(responseText);
      } catch {
        throw new Error("The note endpoint returned invalid JSON.");
      }

      if (!response.ok) {
        throw new Error(
          getErrorMessage(responseJson, "Unable to generate note from transcript."),
        );
      }

      const generatedNote = responseJson as NoteResult;

      if (!getNoteId(generatedNote)) {
        throw new Error(
          "The note was generated, but the server did not return a saved note ID.",
        );
      }

      setNoteResult(generatedNote);
      setBaseNoteResult(generatedNote);
      loadNoteChatHistory(generatedNote);
      setCurrentNoteTranscript(transcriptForNote);
      setCurrentEncounterId("");
      setPatientDraft(getPatientDraftFromNote(generatedNote));
      setPatientRecordStatus("Review detected patient info, then save it to the dashboard.");
      setTranscript("");
      setPendingRecordings([]);
      setCurrentNoteRecordings(getNoteRecordings(generatedNote));
      setCurrentNoteTitle(getStringValue(generatedNote.title));
      setActiveNoteLanguage("Original");
      setSelectedTranslationLanguage("");
      setTranslationStatus("Generated note ready for review.");
      setStatus("Ready");
      setAutosaveStatus("Transcript cleared after saving");
      navigateToView("note");
    } catch (noteGenerationError) {
      setNoteError(
        noteGenerationError instanceof Error
          ? noteGenerationError.message
          : "Note generation failed.",
      );
    } finally {
      setIsGeneratingNote(false);
    }
  };

  const saveCurrentPatientRecord = async (
    options: { silent?: boolean; signature?: string } = {},
  ) => {
    const source = baseNoteResult ?? noteResult;

    if (!source) {
      if (!options.silent) {
        setNoteError("Generate or open a note before saving a patient record.");
      }
      return;
    }

    setIsSavingPatientRecord(true);
    setNoteError("");
    setPatientRecordStatus(options.silent ? "Autosaving..." : "");

    try {
      const savedEncounter = isGuestMode
        ? saveGuestEncounterRecord(guestId, {
            encounterId: currentEncounterId || undefined,
            patientDraft,
            noteJson: toNoteRecord(source),
            transcript: currentNoteTranscript,
            title: currentNoteTitle,
          })
        : await saveEncounterRecord({
            encounterId: currentEncounterId || undefined,
            patientDraft,
            noteJson: toNoteRecord(source),
            transcript: currentNoteTranscript,
            title: currentNoteTitle,
          });
      const savedSummary = toSavedNoteSummary(savedEncounter);
      const savedNoteResult = savedEncounter.result as NoteResult;

      setCurrentEncounterId(savedEncounter.id);
      setCurrentNoteTitle(savedEncounter.title);
      setCurrentNoteTranscript(savedEncounter.transcript);
      setBaseNoteResult(savedNoteResult);
      setNoteResult((current) =>
        activeNoteLanguage === "Original" ? savedNoteResult : current,
      );
      setPatientDraft({
        ...patientDraft,
        patientProfileId: savedEncounter.patientProfileId,
        patientId: savedEncounter.patientId ?? "",
        name: savedEncounter.patientName,
        age:
          savedEncounter.patientAge === undefined
            ? ""
            : String(savedEncounter.patientAge),
        gender: savedEncounter.patientGender ?? "",
        visitDate: getDateInputValue(savedEncounter.visitDate),
        diagnosis: savedEncounter.diagnosis ?? "",
      });
      setSavedNotes((currentNotes) =>
        upsertSavedNoteSummary(currentNotes, savedSummary),
      );
      void loadPatientProfiles();
      lastPatientRecordAutosaveSignatureRef.current =
        options.signature || getPatientRecordAutosaveSignature(savedNoteResult);
      setPatientRecordStatus(
        options.silent
          ? `Autosaved at ${getAutosaveTimeLabel()}`
          : currentEncounterId
            ? "Patient record updated."
            : "Patient record saved to dashboard.",
      );
    } catch (saveError) {
      const message =
        saveError instanceof Error
          ? saveError.message
          : "Unable to save patient record.";

      if (options.silent) {
        setPatientRecordStatus(`Autosave failed: ${message}`);
      } else {
        setNoteError(message);
      }
    } finally {
      setIsSavingPatientRecord(false);
    }
  };

  const assignPatientProfile = (profileId: string) => {
    if (!profileId) {
      setPatientDraft((current) => ({
        ...current,
        patientProfileId: undefined,
      }));
      setPatientRecordStatus("Patient profile unassigned.");
      return;
    }

    const profile = patientProfiles.find(
      (patientProfile) => patientProfile.profileId === profileId,
    );

    if (!profile) {
      setNoteError("Patient profile not found.");
      return;
    }

    setNoteError("");
    setPatientDraft((current) => ({
      ...current,
      ...getPatientProfileDraftPatch(profile),
    }));
    setPatientRecordStatus(`Assigned to ${profile.name}. Autosave will update this note.`);
  };

  const createPatientProfileFromDraft = async () => {
    if (!patientDraft.name.trim()) {
      setNoteError("Add a patient name before creating a profile.");
      return;
    }

    setIsSavingPatientProfile(true);
    setNoteError("");
    setPatientRecordStatus("Creating patient profile...");

    try {
      const profile = isGuestMode
        ? upsertGuestPatientProfile(guestId, {
            patientId: patientDraft.patientId,
            name: patientDraft.name,
            age: patientDraft.age,
            gender: patientDraft.gender,
          })
        : await savePatientProfile({
            patientId: patientDraft.patientId,
            name: patientDraft.name,
            age: patientDraft.age,
            gender: patientDraft.gender,
          });

      setPatientProfiles((currentProfiles) =>
        upsertPatientProfileList(currentProfiles, profile),
      );
      setPatientDraft((current) => ({
        ...current,
        ...getPatientProfileDraftPatch(profile),
      }));
      setPatientRecordStatus(`Patient profile ready: ${profile.name}.`);
    } catch (profileError) {
      setNoteError(
        profileError instanceof Error
          ? profileError.message
          : "Unable to create patient profile.",
      );
      setPatientRecordStatus("");
    } finally {
      setIsSavingPatientProfile(false);
    }
  };

  useEffect(() => {
    let isMounted = true;

    const checkAuth = async () => {
      try {
        const {
          data: { session },
          error: sessionError,
        } = await supabase.auth.getSession();

        if (sessionError) {
          throw sessionError;
        }

        if (isMounted) {
          if (session?.user) {
            await completeSupabaseAuth(session.user);
          } else {
            setCurrentUser(getActiveGuestUser());
          }
        }
      } catch (authCheckError) {
        if (isMounted) {
          setAuthError(
            authCheckError instanceof Error
              ? authCheckError.message
              : "Unable to check your session.",
          );
        }
      } finally {
        if (isMounted) {
          setIsCheckingAuth(false);
        }
      }
    };

    void checkAuth();
    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((_event, session) => {
      if (isMounted) {
        if (session?.user) {
          if (!getPendingGuestSync()) {
            setGuestModeActive(false);
            setCurrentUser(toCurrentUser(session.user));
          }
        } else {
          setCurrentUser(getActiveGuestUser());
        }
      }
    });

    return () => {
      isMounted = false;
      subscription.unsubscribe();
    };
  }, []);

  useEffect(() => {
    if (!currentUser) {
      return;
    }

    void loadSavedNotes();
    void loadPatientProfiles();
  }, [currentUser]);

  useEffect(() => {
    const handlePopState = () => {
      const nextView = getViewFromPathname(window.location.pathname);

      setActiveView(nextView);
      setSelectedPatientProfileId(
        getPatientProfileIdFromPathname(window.location.pathname),
      );

      if (currentUser && (nextView === "dashboard" || nextView === "patient")) {
        void loadSavedNotes();
        void loadPatientProfiles();
      }
    };

    window.addEventListener("popstate", handlePopState);

    return () => {
      window.removeEventListener("popstate", handlePopState);
    };
  }, [currentUser]);

  useEffect(() => {
    if (!isNoteChatOpen) {
      return;
    }

    noteChatMessagesEndRef.current?.scrollIntoView({ block: "end" });
  }, [isNoteChatOpen, isEditingNoteWithAi, noteChatMessages]);

  useEffect(() => {
    if (!currentUser) {
      setHasHydratedAutosave(false);
      return;
    }

    try {
      const savedDraft = localStorage.getItem(getAutosaveKey(currentUser.id));

      if (!savedDraft) {
        setAutosaveStatus("Autosave ready");
        setHasHydratedAutosave(true);
        return;
      }

      const parsedDraft = JSON.parse(savedDraft) as unknown;

      if (
        !parsedDraft ||
        typeof parsedDraft !== "object" ||
        Array.isArray(parsedDraft)
      ) {
        setAutosaveStatus("Autosave ready");
        setHasHydratedAutosave(true);
        return;
      }

      const draft = parsedDraft as Record<string, unknown>;
      const restoredNote = asNoteResultDraft(draft.noteResult);
      const restoredBaseNote = asNoteResultDraft(draft.baseNoteResult);
      setTranscript(typeof draft.transcript === "string" ? draft.transcript : "");
      setNoteResult(restoredNote);
      setBaseNoteResult(restoredBaseNote);
      loadNoteChatHistory(restoredBaseNote ?? restoredNote);
      setCurrentNoteTranscript(
        typeof draft.currentNoteTranscript === "string"
          ? draft.currentNoteTranscript
          : "",
      );
      setPendingRecordings(getNoteRecordings({ recordings: draft.pendingRecordings }));
      setCurrentNoteRecordings(
        getNoteRecordings({ recordings: draft.currentNoteRecordings }),
      );
      setCurrentNoteTitle(
        typeof draft.currentNoteTitle === "string" ? draft.currentNoteTitle : "",
      );
      setCurrentEncounterId(
        typeof draft.currentEncounterId === "string" ? draft.currentEncounterId : "",
      );
      setPatientDraft(
        draft.patientDraft && typeof draft.patientDraft === "object"
          ? {
              ...getPatientDraftFromNote(restoredBaseNote ?? restoredNote),
              ...(draft.patientDraft as PatientDraft),
            }
          : getPatientDraftFromNote(restoredBaseNote ?? restoredNote),
      );
      setPatientRecordStatus(
        typeof draft.patientRecordStatus === "string"
          ? draft.patientRecordStatus
          : "",
      );
      setActiveNoteLanguage(
        typeof draft.activeNoteLanguage === "string"
          ? draft.activeNoteLanguage
          : "Original",
      );
      setSelectedTranslationLanguage(
        typeof draft.selectedTranslationLanguage === "string"
          ? draft.selectedTranslationLanguage
          : "",
      );
      setAutosaveStatus("Draft restored from autosave");
    } catch {
      setAutosaveStatus("Autosave unavailable");
    } finally {
      setHasHydratedAutosave(true);
    }
  }, [currentUser]);

  useEffect(() => {
    if (!currentUser || !hasHydratedAutosave) {
      return;
    }

    const timeoutId = window.setTimeout(() => {
      try {
        if (suppressNextAutosaveRef.current) {
          suppressNextAutosaveRef.current = false;
          localStorage.removeItem(getAutosaveKey(currentUser.id));
          setAutosaveStatus("Transcript cleared");
          return;
        }

        const hasDraft =
          transcript.trim().length > 0 ||
          Boolean(noteResult) ||
          Boolean(baseNoteResult) ||
          currentNoteTranscript.trim().length > 0 ||
          pendingRecordings.length > 0 ||
          currentNoteRecordings.length > 0 ||
          currentNoteTitle.trim().length > 0;

        if (!hasDraft) {
          localStorage.removeItem(getAutosaveKey(currentUser.id));
          setAutosaveStatus("Autosave ready");
          return;
        }

        localStorage.setItem(
          getAutosaveKey(currentUser.id),
          JSON.stringify({
            activeView,
            transcript,
            noteResult,
            baseNoteResult,
          currentNoteTranscript,
          pendingRecordings,
          currentNoteRecordings,
          currentNoteTitle,
          currentEncounterId,
          patientDraft,
          patientRecordStatus,
          activeNoteLanguage,
          selectedTranslationLanguage,
            updatedAt: new Date().toISOString(),
          }),
        );
        setAutosaveStatus(`Autosaved at ${getAutosaveTimeLabel()}`);
      } catch {
        setAutosaveStatus("Autosave unavailable");
      }
    }, AUTOSAVE_DELAY_MS);

    return () => {
      window.clearTimeout(timeoutId);
    };
  }, [
    activeNoteLanguage,
    activeView,
    baseNoteResult,
    currentNoteTranscript,
    currentNoteRecordings,
    currentNoteTitle,
    currentEncounterId,
    currentUser,
    hasHydratedAutosave,
    noteResult,
    patientDraft,
    patientRecordStatus,
    pendingRecordings,
    selectedTranslationLanguage,
    transcript,
  ]);

  useEffect(() => {
    const source = baseNoteResult ?? noteResult;

    if (
      !currentUser ||
      activeView !== "note" ||
      !source ||
      !currentNoteTranscript.trim() ||
      isGeneratingNote ||
      isTranslating ||
      isSavingPatientRecord
    ) {
      return;
    }

    const signature = getPatientRecordAutosaveSignature(source);

    if (signature === lastPatientRecordAutosaveSignatureRef.current) {
      return;
    }

    const timeoutId = window.setTimeout(() => {
      void saveCurrentPatientRecord({ silent: true, signature });
    }, NOTE_RECORD_AUTOSAVE_DELAY_MS);

    return () => {
      window.clearTimeout(timeoutId);
    };
  }, [
    activeView,
    baseNoteResult,
    currentNoteTitle,
    currentNoteTranscript,
    currentUser,
    isGeneratingNote,
    isSavingPatientRecord,
    isTranslating,
    noteResult,
    patientDraft,
  ]);

  useEffect(() => {
    const sequence = ["w", "w", "a", "a", "s", "s", "d", "d"];
    let sequenceIndex = 0;

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.altKey || event.ctrlKey || event.metaKey) {
        return;
      }

      const key = event.key.toLowerCase();

      if (key === sequence[sequenceIndex]) {
        sequenceIndex += 1;
      } else {
        sequenceIndex = key === sequence[0] ? 1 : 0;
      }

      if (sequenceIndex === sequence.length) {
        setShowDebugPanel((current) => !current);
        sequenceIndex = 0;
      }
    };

    window.addEventListener("keydown", handleKeyDown);

    return () => {
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, []);

  useEffect(() => {
    return cleanupRecording;
  }, []);

  if (isCheckingAuth) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-zinc-100 px-4 py-8 text-zinc-950">
        <div className="rounded-[2rem] border border-zinc-200 bg-white p-6 text-sm text-zinc-600 shadow-sm">
          Checking your session...
        </div>
      </main>
    );
  }

  if (!currentUser) {
    const isSignup = authMode === "signup";

    return (
      <main className="min-h-screen bg-zinc-100 px-4 py-8 text-zinc-950 sm:px-6 lg:px-8">
        <section className="mx-auto flex min-h-[calc(100vh-4rem)] max-w-md items-center">
          <div className="w-full rounded-[2rem] border border-zinc-200 bg-white p-6 shadow-sm sm:p-8">
            <div className="flex items-center gap-4">
              <img
                alt="ClinicScribe"
                className="h-16 min-w-0 max-w-[14rem] object-contain sm:h-20"
                src={BRAND_LOGO_SRC}
              />
            </div>
            <h1 className="mt-5 text-2xl font-semibold tracking-normal text-zinc-950">
              {isSignup ? "Create your account" : "Sign in"}
            </h1>
            <p className="mt-2 text-sm leading-6 text-zinc-500">
              Keep clinic transcription behind your own account.
            </p>

            <form className="mt-6 space-y-4" onSubmit={handleAuthSubmit}>
              {isSignup ? (
                <label className="block text-sm font-medium text-zinc-700">
                  Name
                  <input
                    className="mt-2 w-full rounded-lg border border-zinc-200 bg-zinc-50 px-3 py-3 text-zinc-950 outline-none transition focus:border-zinc-400 focus:bg-white focus:ring-4 focus:ring-zinc-100"
                    onChange={(event) => setAuthName(event.target.value)}
                    placeholder="Dr. Nguyen"
                    type="text"
                    value={authName}
                  />
                </label>
              ) : null}

              <label className="block text-sm font-medium text-zinc-700">
                Email
                <input
                  autoComplete="email"
                  className="mt-2 w-full rounded-lg border border-zinc-200 bg-zinc-50 px-3 py-3 text-zinc-950 outline-none transition focus:border-zinc-400 focus:bg-white focus:ring-4 focus:ring-zinc-100"
                  onChange={(event) => setAuthEmail(event.target.value)}
                  placeholder="you@clinic.com"
                  required
                  type="email"
                  value={authEmail}
                />
              </label>

              <label className="block text-sm font-medium text-zinc-700">
                Password
                <span className="mt-2 flex overflow-hidden rounded-lg border border-zinc-200 bg-zinc-50 transition focus-within:border-zinc-400 focus-within:bg-white focus-within:ring-4 focus-within:ring-zinc-100">
                  <input
                    autoComplete={isSignup ? "new-password" : "current-password"}
                    className="min-w-0 flex-1 bg-transparent px-3 py-3 text-zinc-950 outline-none"
                    minLength={8}
                    onChange={(event) => setAuthPassword(event.target.value)}
                    placeholder="At least 8 characters"
                    required
                    type={showAuthPassword ? "text" : "password"}
                    value={authPassword}
                  />
                  <button
                    className="shrink-0 border-l border-zinc-200 px-3 text-xs font-semibold text-zinc-600 transition hover:bg-white"
                    onClick={() => setShowAuthPassword((current) => !current)}
                    tabIndex={-1}
                    type="button"
                  >
                    {showAuthPassword ? "Hide" : "Show"}
                  </button>
                </span>
              </label>

              {isSignup ? (
                <label className="block text-sm font-medium text-zinc-700">
                  Confirm password
                  <span className="mt-2 flex overflow-hidden rounded-lg border border-zinc-200 bg-zinc-50 transition focus-within:border-zinc-400 focus-within:bg-white focus-within:ring-4 focus-within:ring-zinc-100">
                    <input
                      autoComplete="new-password"
                      className="min-w-0 flex-1 bg-transparent px-3 py-3 text-zinc-950 outline-none"
                      minLength={8}
                      onChange={(event) =>
                        setAuthPasswordConfirmation(event.target.value)
                      }
                      placeholder="Type it again"
                      required
                      type={showAuthPasswordConfirmation ? "text" : "password"}
                      value={authPasswordConfirmation}
                    />
                    <button
                      className="shrink-0 border-l border-zinc-200 px-3 text-xs font-semibold text-zinc-600 transition hover:bg-white"
                      onClick={() =>
                        setShowAuthPasswordConfirmation((current) => !current)
                      }
                      tabIndex={-1}
                      type="button"
                    >
                      {showAuthPasswordConfirmation ? "Hide" : "Show"}
                    </button>
                  </span>
                </label>
              ) : null}

              {authError ? (
                <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
                  {authError}
                </div>
              ) : null}

              <button
                className="w-full rounded-lg bg-zinc-950 px-5 py-3 text-sm font-semibold text-white shadow-sm transition hover:bg-zinc-800 disabled:cursor-not-allowed disabled:bg-zinc-400"
                disabled={isAuthSubmitting}
                type="submit"
              >
                {isAuthSubmitting
                  ? isSignup
                    ? "Creating account..."
                    : "Signing in..."
                  : isSignup
                    ? "Create account"
                    : "Sign in"}
              </button>
            </form>

            <button
              className="mt-5 w-full rounded-lg border border-zinc-300 px-4 py-3 text-sm font-semibold text-zinc-700 transition hover:border-zinc-400 hover:bg-zinc-50"
              onClick={() => {
                setAuthMode(isSignup ? "login" : "signup");
                setAuthError("");
                setAuthPassword("");
                setAuthPasswordConfirmation("");
                setShowAuthPassword(false);
                setShowAuthPasswordConfirmation(false);
              }}
              type="button"
            >
              {isSignup ? "I already have an account" : "Create an account"}
            </button>

            <button
              className="mt-3 w-full rounded-lg border border-zinc-300 px-4 py-3 text-sm font-semibold text-zinc-700 transition hover:border-zinc-400 hover:bg-zinc-50"
              onClick={enterGuestMode}
              type="button"
            >
              Continue as guest
            </button>
            <p className="mt-3 text-xs leading-5 text-zinc-500">
              Guest records stay in this browser. Create an account to sync!
            </p>
          </div>
        </section>
      </main>
    );
  }

  const currentNoteId = getNoteId(baseNoteResult ?? noteResult);
  const sourceNote = baseNoteResult ?? noteResult;
  const originalNoteLanguage = getOriginalNoteLanguage(sourceNote);
  const translationLanguages = getTranslationLanguages(sourceNote);
  const savedNoteLanguages = uniqueLanguages([
    originalNoteLanguage,
    ...translationLanguages,
  ]);
  const languageOptions = uniqueLanguages([
    ...LANGUAGE_OPTIONS,
    originalNoteLanguage,
  ]);
  const filteredLanguages = languageOptions.filter((language) =>
    language.toLowerCase().includes(languageSearch.trim().toLowerCase()),
  );
  const noteHeading = currentNoteTitle || getStringValue(noteResult?.title);
  const hasCurrentDraft =
    transcript.trim().length > 0 ||
    Boolean(noteResult) ||
    Boolean(baseNoteResult) ||
    currentNoteTranscript.trim().length > 0 ||
    pendingRecordings.length > 0 ||
    currentNoteRecordings.length > 0 ||
    currentNoteTitle.trim().length > 0;
  const hasCurrentNoteTranscript = currentNoteTranscript.trim().length > 0;
  const noteSourceMaterialsLabel = [
    hasCurrentNoteTranscript ? "Transcript" : "",
    currentNoteRecordings.length > 0
      ? `${currentNoteRecordings.length} recording${
          currentNoteRecordings.length === 1 ? "" : "s"
        }`
      : "",
  ]
    .filter(Boolean)
    .join(" + ");
  const selectedLanguageLabel = selectedTranslationLanguage
    ? `Translate to ${selectedTranslationLanguage}`
    : "Choose language";
  const selectedLanguageIsOriginal =
    Boolean(originalNoteLanguage && selectedTranslationLanguage) &&
    getLanguageKey(selectedTranslationLanguage) === getLanguageKey(originalNoteLanguage);
  const translateButtonLabel = isTranslating
    ? selectedTranslationLanguage
      ? `Translating to ${selectedTranslationLanguage}...`
      : "Translating..."
    : selectedLanguageIsOriginal
      ? "Show saved original"
      : "Translate";
  const activeNoteLabel =
    activeNoteLanguage === "Original"
      ? originalNoteLanguage
        ? `Saved original ${originalNoteLanguage} note`
        : "Saved original note"
      : `${activeNoteLanguage} translation`;
  const displayedNoteHeading =
    getStringValue(noteResult?.visit_summary) ||
    noteHeading ||
    "Saved ClinicScribe note";
  const exportCurrentNotePdf = () => {
    if (!noteResult) {
      setNoteError("Generate or open a note before exporting a PDF.");
      return;
    }

    const pdfWindow = window.open("", "_blank", "width=900,height=1200");

    if (!pdfWindow) {
      setNoteError("Allow pop-ups for ClinicScribe, then try exporting again.");
      return;
    }

    setNoteError("");
    pdfWindow.document.open();
    pdfWindow.document.write(
      buildPrintableNoteHtml({
        note: noteResult,
        patientDraft,
        heading: displayedNoteHeading,
        noteLabel: activeNoteLabel,
      }),
    );
    pdfWindow.document.close();

    let didPrint = false;
    const printPdf = () => {
      if (didPrint) {
        return;
      }

      didPrint = true;
      pdfWindow.focus();
      pdfWindow.print();
    };

    pdfWindow.addEventListener(
      "load",
      () => {
        window.setTimeout(printPdf, 100);
      },
      { once: true },
    );
    window.setTimeout(printPdf, 300);
  };
  const dashboardSearchTerm = dashboardSearch.trim().toLowerCase();
  const dashboardPatientNameOptions = getUniqueSortedValues(
    savedNotes.map((savedNote) => savedNote.patientName),
  );
  const dashboardPatientIdOptions = getUniqueSortedValues(
    savedNotes.map((savedNote) => savedNote.patientId),
  );
  const dashboardGenderOptions = getUniqueSortedValues(
    savedNotes.map((savedNote) => savedNote.patientGender),
  );
  const dashboardMinAge = parseFilterNumber(dashboardFilters.ageMin);
  const dashboardMaxAge = parseFilterNumber(dashboardFilters.ageMax);
  const dashboardDiagnosisFilter = dashboardFilters.diagnosis.trim().toLowerCase();
  const activeDashboardFilterCount =
    getActiveDashboardFilterCount(dashboardFilters);
  const visibleSavedNotes = savedNotes
    .filter((savedNote) => {
      if (!dashboardSearchTerm) {
        return true;
      }

      return [
        savedNote.patientId,
        savedNote.patientName,
        savedNote.title,
        savedNote.diagnosis,
        savedNote.language_detected,
      ]
        .filter(Boolean)
        .some((value) =>
          String(value).toLowerCase().includes(dashboardSearchTerm),
        );
    })
    .filter((savedNote) => {
      if (!selectionIncludes(dashboardFilters.patientNames, savedNote.patientName)) {
        return false;
      }

      if (!selectionIncludes(dashboardFilters.patientIds, savedNote.patientId)) {
        return false;
      }

      if (!selectionIncludes(dashboardFilters.genders, savedNote.patientGender)) {
        return false;
      }

      if (
        dashboardMinAge !== undefined &&
        (savedNote.patientAge === undefined || savedNote.patientAge < dashboardMinAge)
      ) {
        return false;
      }

      if (
        dashboardMaxAge !== undefined &&
        (savedNote.patientAge === undefined || savedNote.patientAge > dashboardMaxAge)
      ) {
        return false;
      }

      if (
        dashboardDiagnosisFilter &&
        !normalizeFilterKey(savedNote.diagnosis).includes(dashboardDiagnosisFilter)
      ) {
        return false;
      }

      const visitDate = getDateInputValue(savedNote.visitDate ?? savedNote.createdAt);

      if (dashboardFilters.visitDateFrom && visitDate < dashboardFilters.visitDateFrom) {
        return false;
      }

      if (dashboardFilters.visitDateTo && visitDate > dashboardFilters.visitDateTo) {
        return false;
      }

      return true;
    })
    .sort((left, right) => {
      if (left.pinned !== right.pinned) {
        return left.pinned ? -1 : 1;
      }

      if (dashboardSort === "patient") {
        return (left.patientName || left.title).localeCompare(
          right.patientName || right.title,
        );
      }

      if (dashboardSort === "oldest") {
        return getSavedNoteVisitTime(left) - getSavedNoteVisitTime(right);
      }

      return getSavedNoteVisitTime(right) - getSavedNoteVisitTime(left);
    });
  const assignedPatientProfile = patientDraft.patientProfileId
    ? patientProfiles.find(
        (profile) => profile.profileId === patientDraft.patientProfileId,
      )
    : undefined;
  const selectedPatientProfile = selectedPatientProfileId
    ? patientProfiles.find(
        (profile) => profile.profileId === selectedPatientProfileId,
      )
    : undefined;
  const selectedPatientProfileNotes = selectedPatientProfile
    ? savedNotes
        .filter((savedNote) =>
          savedNoteMatchesPatientProfile(savedNote, selectedPatientProfile),
        )
        .sort((left, right) => getSavedNoteVisitTime(right) - getSavedNoteVisitTime(left))
    : [];
  const pageTitle =
    activeView === "dashboard"
      ? "Patient dashboard"
      : activeView === "patient"
        ? selectedPatientProfile?.name ?? "Patient profile"
      : activeView === "note"
        ? "Clinical note"
        : "ClinicScribe";
  const pageDescription =
    activeView === "dashboard"
      ? "Search and sort saved patient encounters."
      : activeView === "patient"
        ? "Patient profile and saved encounters."
      : activeView === "scribe"
        ? "Clinical notes faster, clearer, and ready for review."
        : "";

  return (
    <main className="min-h-screen bg-zinc-100 px-4 py-8 text-zinc-950 sm:px-6 lg:px-8">
      <section className="mx-auto flex max-w-5xl flex-col gap-6">
        <div
          className={`border border-zinc-200 bg-white shadow-sm ${
            activeView === "note"
              ? "rounded-2xl p-4"
              : "rounded-[2rem] p-6 sm:p-8"
          }`}
        >
          <div
            className={`flex flex-col lg:flex-row lg:justify-between ${
              activeView === "note"
                ? "gap-3 lg:items-center"
                : "mb-6 gap-5 lg:items-start"
            }`}
          >
            <div className="flex min-w-0 items-start gap-4">
              <div className="min-w-0">
                {activeView === "scribe" ? (
                  <img
                    alt="ClinicScribe"
                    className="h-16 max-w-full object-contain sm:h-20"
                    src={BRAND_LOGO_SRC}
                  />
                ) : (
                  <h1
                    className={`font-semibold tracking-normal text-zinc-950 ${
                      activeView === "note" ? "text-xl" : "text-2xl"
                    }`}
                  >
                    {pageTitle}
                  </h1>
                )}
                {pageDescription ? (
                  <p
                    className={`${
                      activeView === "scribe" ? "mt-3" : "mt-2"
                    } text-sm text-zinc-500`}
                  >
                    {pageDescription}
                  </p>
                ) : null}
              </div>
            </div>

            <div
              className={`shrink-0 border border-zinc-200 bg-zinc-50 ${
                activeView === "note"
                  ? "rounded-lg px-3 py-2 text-xs"
                  : "rounded-2xl px-4 py-3 text-sm"
              }`}
            >
              <p className="font-medium text-zinc-700">
                {isGuestMode ? "Guest mode" : "Signed in"}
              </p>
              <p className="mt-1 text-zinc-950">{currentUser.name}</p>
              <p className="mt-1 text-xs text-zinc-500">{currentUser.email}</p>
              {isGuestMode ? (
                <div
                  className={`flex flex-wrap gap-2 ${
                    activeView === "note" ? "mt-2" : "mt-3"
                  }`}
                >
                  <button
                    className="rounded-lg border border-zinc-300 px-3 py-2 text-xs font-semibold text-zinc-700 transition hover:border-zinc-400 hover:bg-white"
                    onClick={() => startGuestAccountSync("signup")}
                    type="button"
                  >
                    Create account
                  </button>
                  <button
                    className="rounded-lg border border-zinc-300 px-3 py-2 text-xs font-semibold text-zinc-700 transition hover:border-zinc-400 hover:bg-white"
                    onClick={() => startGuestAccountSync("login")}
                    type="button"
                  >
                    Sign in
                  </button>
                  <button
                    className="rounded-lg border border-zinc-300 px-3 py-2 text-xs font-semibold text-zinc-700 transition hover:border-zinc-400 hover:bg-white"
                    disabled={isLoggingOut}
                    onClick={() => void handleLogout()}
                    type="button"
                  >
                    {isLoggingOut ? "Exiting..." : "Exit guest"}
                  </button>
                </div>
              ) : (
                <button
                  className={`rounded-lg border border-zinc-300 px-3 py-2 text-xs font-semibold text-zinc-700 transition hover:border-zinc-400 hover:bg-white ${
                    activeView === "note" ? "mt-2" : "mt-3"
                  }`}
                  disabled={isLoggingOut}
                  onClick={() => void handleLogout()}
                  type="button"
                >
                  {isLoggingOut ? "Signing out..." : "Sign out"}
                </button>
              )}
            </div>
          </div>

          <div
            className={`flex flex-wrap gap-2 ${
              activeView === "note" ? "mt-3" : "mb-6"
            }`}
          >
            {activeView !== "scribe" ? (
              <button
                className={`rounded-lg border border-zinc-300 font-semibold text-zinc-700 transition hover:border-zinc-400 hover:bg-zinc-50 ${
                  activeView === "note" ? "px-3 py-2 text-xs" : "px-4 py-2 text-sm"
                }`}
                onClick={() => navigateToView("scribe")}
                type="button"
              >
                Return home
              </button>
            ) : null}

            {activeView !== "dashboard" ? (
              <button
                className={`rounded-lg border border-zinc-300 font-semibold text-zinc-700 transition hover:border-zinc-400 hover:bg-zinc-50 ${
                  activeView === "note" ? "px-3 py-2 text-xs" : "px-4 py-2 text-sm"
                }`}
                onClick={() => navigateToView("dashboard")}
                type="button"
              >
                Open dashboard
              </button>
            ) : null}

            {activeView === "dashboard" ? (
              <IconButton
                disabled={isLoadingNotes}
                icon="refresh"
                label={isLoadingNotes ? "Refreshing" : "Refresh"}
                onClick={() => void loadSavedNotes()}
              />
            ) : null}
          </div>

          {activeView === "dashboard" ? (
            <div className="rounded-2xl border border-zinc-200 p-5">
              {vaultError ? (
                <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
                  {vaultError}
                </div>
              ) : null}

              <div className="mt-5 grid gap-3 lg:grid-cols-[1fr_auto_auto] lg:items-end">
                <label className="block text-sm font-medium text-zinc-700">
                  Search records
                  <input
                    className="mt-2 w-full rounded-lg border border-zinc-200 bg-zinc-50 px-3 py-2 text-zinc-950 outline-none transition focus:border-zinc-400 focus:bg-white focus:ring-4 focus:ring-zinc-100"
                    onChange={(event) => setDashboardSearch(event.target.value)}
                    placeholder="Patient, ID, diagnosis, or note title"
                    type="search"
                    value={dashboardSearch}
                  />
                </label>

                <label className="block text-sm font-medium text-zinc-700 lg:w-52">
                  Sort by
                  <select
                    className="mt-2 w-full rounded-lg border border-zinc-200 bg-zinc-50 px-3 py-2 text-zinc-950 outline-none transition focus:border-zinc-400 focus:bg-white focus:ring-4 focus:ring-zinc-100"
                    onChange={(event) =>
                      setDashboardSort(event.target.value as DashboardSort)
                    }
                    value={dashboardSort}
                  >
                    <option value="newest">Newest visit</option>
                    <option value="oldest">Oldest visit</option>
                    <option value="patient">Patient name</option>
                  </select>
                </label>

                <button
                  className="inline-flex h-10 items-center justify-center gap-2 rounded-lg border border-zinc-300 px-4 text-sm font-semibold text-zinc-700 transition hover:border-zinc-400 hover:bg-zinc-50"
                  onClick={() => setIsDashboardFilterPanelOpen(true)}
                  type="button"
                >
                  <Icon name="filter" />
                  Filters
                  {activeDashboardFilterCount > 0 ? (
                    <span className="rounded-lg bg-zinc-950 px-2 py-0.5 text-xs text-white">
                      {activeDashboardFilterCount}
                    </span>
                  ) : null}
                </button>
              </div>

              {isDashboardFilterPanelOpen ? (
                <div className="fixed inset-0 z-40">
                  <button
                    aria-label="Close filters"
                    className="absolute inset-0 bg-zinc-950/30"
                    onClick={() => setIsDashboardFilterPanelOpen(false)}
                    type="button"
                  />

                  <aside className="absolute right-0 top-0 flex h-full w-full max-w-md flex-col border-l border-zinc-200 bg-white shadow-2xl">
                    <div className="flex items-start justify-between gap-4 border-b border-zinc-200 px-5 py-4">
                      <div>
                        <h2 className="text-lg font-semibold text-zinc-950">
                          Filters
                        </h2>
                        <p className="mt-1 text-sm text-zinc-500">
                          Narrow saved patient encounters.
                        </p>
                      </div>
                      <IconButton
                        icon="x"
                        label="Close filters"
                        onClick={() => setIsDashboardFilterPanelOpen(false)}
                      />
                    </div>

                    <div className="min-h-0 flex-1 space-y-6 overflow-y-auto px-5 py-5">
                      <section>
                        <h3 className="text-sm font-semibold text-zinc-900">
                          Patient name
                        </h3>
                        <div className="mt-3 max-h-40 space-y-2 overflow-y-auto rounded-lg border border-zinc-200 p-3">
                          {dashboardPatientNameOptions.length > 0 ? (
                            dashboardPatientNameOptions.map((patientName) => (
                              <label
                                className="flex items-center gap-2 text-sm text-zinc-700"
                                key={patientName}
                              >
                                <input
                                  checked={dashboardFilters.patientNames.some(
                                    (selectedName) =>
                                      normalizeFilterKey(selectedName) ===
                                      normalizeFilterKey(patientName),
                                  )}
                                  className="h-4 w-4 rounded border-zinc-300 text-zinc-950 focus:ring-zinc-400"
                                  onChange={() =>
                                    setDashboardFilters((current) => ({
                                      ...current,
                                      patientNames: toggleFilterValue(
                                        current.patientNames,
                                        patientName,
                                      ),
                                    }))
                                  }
                                  type="checkbox"
                                />
                                <span>{patientName}</span>
                              </label>
                            ))
                          ) : (
                            <p className="text-sm text-zinc-500">
                              No saved patient names yet.
                            </p>
                          )}
                        </div>
                      </section>

                      <section>
                        <h3 className="text-sm font-semibold text-zinc-900">
                          Patient ID
                        </h3>
                        <div className="mt-3 max-h-40 space-y-2 overflow-y-auto rounded-lg border border-zinc-200 p-3">
                          {dashboardPatientIdOptions.length > 0 ? (
                            dashboardPatientIdOptions.map((patientId) => (
                              <label
                                className="flex items-center gap-2 text-sm text-zinc-700"
                                key={patientId}
                              >
                                <input
                                  checked={dashboardFilters.patientIds.some(
                                    (selectedId) =>
                                      normalizeFilterKey(selectedId) ===
                                      normalizeFilterKey(patientId),
                                  )}
                                  className="h-4 w-4 rounded border-zinc-300 text-zinc-950 focus:ring-zinc-400"
                                  onChange={() =>
                                    setDashboardFilters((current) => ({
                                      ...current,
                                      patientIds: toggleFilterValue(
                                        current.patientIds,
                                        patientId,
                                      ),
                                    }))
                                  }
                                  type="checkbox"
                                />
                                <span>{patientId}</span>
                              </label>
                            ))
                          ) : (
                            <p className="text-sm text-zinc-500">
                              Add a Patient ID to a record to filter by it.
                            </p>
                          )}
                        </div>
                      </section>

                      <section>
                        <h3 className="text-sm font-semibold text-zinc-900">
                          Age
                        </h3>
                        <div className="mt-3 grid grid-cols-2 gap-3">
                          <label className="block text-sm font-medium text-zinc-700">
                            Min
                            <input
                              className="mt-2 w-full rounded-lg border border-zinc-200 bg-zinc-50 px-3 py-2 text-zinc-950 outline-none transition focus:border-zinc-400 focus:bg-white focus:ring-4 focus:ring-zinc-100"
                              max="130"
                              min="0"
                              onChange={(event) =>
                                setDashboardFilters((current) => ({
                                  ...current,
                                  ageMin: event.target.value,
                                }))
                              }
                              type="number"
                              value={dashboardFilters.ageMin}
                            />
                          </label>
                          <label className="block text-sm font-medium text-zinc-700">
                            Max
                            <input
                              className="mt-2 w-full rounded-lg border border-zinc-200 bg-zinc-50 px-3 py-2 text-zinc-950 outline-none transition focus:border-zinc-400 focus:bg-white focus:ring-4 focus:ring-zinc-100"
                              max="130"
                              min="0"
                              onChange={(event) =>
                                setDashboardFilters((current) => ({
                                  ...current,
                                  ageMax: event.target.value,
                                }))
                              }
                              type="number"
                              value={dashboardFilters.ageMax}
                            />
                          </label>
                        </div>
                      </section>

                      <section>
                        <h3 className="text-sm font-semibold text-zinc-900">
                          Gender
                        </h3>
                        <div className="mt-3 space-y-2 rounded-lg border border-zinc-200 p-3">
                          {dashboardGenderOptions.length > 0 ? (
                            dashboardGenderOptions.map((gender) => (
                              <label
                                className="flex items-center gap-2 text-sm text-zinc-700"
                                key={gender}
                              >
                                <input
                                  checked={dashboardFilters.genders.some(
                                    (selectedGender) =>
                                      normalizeFilterKey(selectedGender) ===
                                      normalizeFilterKey(gender),
                                  )}
                                  className="h-4 w-4 rounded border-zinc-300 text-zinc-950 focus:ring-zinc-400"
                                  onChange={() =>
                                    setDashboardFilters((current) => ({
                                      ...current,
                                      genders: toggleFilterValue(
                                        current.genders,
                                        gender,
                                      ),
                                    }))
                                  }
                                  type="checkbox"
                                />
                                <span>{gender}</span>
                              </label>
                            ))
                          ) : (
                            <p className="text-sm text-zinc-500">
                              No saved gender values yet.
                            </p>
                          )}
                        </div>
                      </section>

                      <section>
                        <label className="block text-sm font-semibold text-zinc-900">
                          Diagnosis
                          <input
                            className="mt-3 w-full rounded-lg border border-zinc-200 bg-zinc-50 px-3 py-2 text-zinc-950 outline-none transition focus:border-zinc-400 focus:bg-white focus:ring-4 focus:ring-zinc-100"
                            onChange={(event) =>
                              setDashboardFilters((current) => ({
                                ...current,
                                diagnosis: event.target.value,
                              }))
                            }
                            placeholder="Contains..."
                            type="text"
                            value={dashboardFilters.diagnosis}
                          />
                        </label>
                      </section>

                      <section>
                        <h3 className="text-sm font-semibold text-zinc-900">
                          Visit date
                        </h3>
                        <div className="mt-3 grid grid-cols-2 gap-3">
                          <label className="block text-sm font-medium text-zinc-700">
                            From
                            <input
                              className="mt-2 w-full rounded-lg border border-zinc-200 bg-zinc-50 px-3 py-2 text-zinc-950 outline-none transition focus:border-zinc-400 focus:bg-white focus:ring-4 focus:ring-zinc-100"
                              onChange={(event) =>
                                setDashboardFilters((current) => ({
                                  ...current,
                                  visitDateFrom: event.target.value,
                                }))
                              }
                              type="date"
                              value={dashboardFilters.visitDateFrom}
                            />
                          </label>
                          <label className="block text-sm font-medium text-zinc-700">
                            To
                            <input
                              className="mt-2 w-full rounded-lg border border-zinc-200 bg-zinc-50 px-3 py-2 text-zinc-950 outline-none transition focus:border-zinc-400 focus:bg-white focus:ring-4 focus:ring-zinc-100"
                              onChange={(event) =>
                                setDashboardFilters((current) => ({
                                  ...current,
                                  visitDateTo: event.target.value,
                                }))
                              }
                              type="date"
                              value={dashboardFilters.visitDateTo}
                            />
                          </label>
                        </div>
                      </section>
                    </div>

                    <div className="flex items-center justify-between gap-3 border-t border-zinc-200 px-5 py-4">
                      <button
                        className="rounded-lg border border-zinc-300 px-4 py-2 text-sm font-semibold text-zinc-700 transition hover:border-zinc-400 hover:bg-zinc-50 disabled:cursor-not-allowed disabled:text-zinc-400"
                        disabled={activeDashboardFilterCount === 0}
                        onClick={() =>
                          setDashboardFilters(EMPTY_DASHBOARD_FILTERS)
                        }
                        type="button"
                      >
                        Clear filters
                      </button>
                      <button
                        className="rounded-lg bg-zinc-950 px-4 py-2 text-sm font-semibold text-white transition hover:bg-zinc-800"
                        onClick={() => setIsDashboardFilterPanelOpen(false)}
                        type="button"
                      >
                        Done
                      </button>
                    </div>
                  </aside>
                </div>
              ) : null}

              <div className="mt-5 space-y-3">
                {visibleSavedNotes.length === 0 && !isLoadingNotes ? (
                  <p className="rounded-xl bg-zinc-50 px-4 py-3 text-sm text-zinc-500">
                    No patient records yet.
                  </p>
                ) : null}

                {visibleSavedNotes.map((savedNote) => (
                  <div
                    className="rounded-xl border border-zinc-200 bg-white px-4 py-3 transition hover:border-zinc-400 hover:bg-zinc-50"
                    key={savedNote.id}
                  >
                    <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
                      <button
                        className="min-w-0 flex-1 text-left"
                        onClick={() => void openSavedNote(savedNote.id)}
                        type="button"
                      >
                        <p className="flex items-center gap-2 font-semibold text-zinc-950">
                          {savedNote.pinned ? (
                            <span
                              className="inline-flex text-zinc-700"
                              title="Pinned"
                            >
                              <Icon name="pin" />
                            </span>
                          ) : null}
                          <span>{savedNote.patientName || savedNote.title}</span>
                        </p>
                        <p className="mt-1 text-sm text-zinc-500">
                          {savedNote.patientId
                            ? `ID ${savedNote.patientId} - `
                            : ""}
                          {savedNote.patientAge !== undefined
                            ? `Age ${savedNote.patientAge} - `
                            : ""}
                          {savedNote.patientGender
                            ? `${savedNote.patientGender} - `
                            : ""}
                          {savedNote.diagnosis
                            ? `${savedNote.diagnosis} - `
                            : ""}
                          {savedNote.visitDate
                            ? formatDate(savedNote.visitDate)
                            : formatDate(savedNote.createdAt)}
                          {savedNote.language_detected
                            ? ` - ${savedNote.language_detected} original`
                            : ""}
                          {savedNote.recording_count
                            ? ` - ${savedNote.recording_count} recording${
                                savedNote.recording_count === 1 ? "" : "s"
                              }`
                            : ""}
                          {savedNote.translation_languages?.length
                            ? ` - ${savedNote.translation_languages.join(", ")}`
                            : ""}
                        </p>
                        <p className="mt-1 text-xs text-zinc-400">
                          {savedNote.title}
                        </p>
                      </button>

                      <div className="flex flex-wrap gap-2">
                        <button
                          className="rounded-lg border border-zinc-300 px-3 py-2 text-xs font-semibold text-zinc-700 transition hover:border-zinc-400 hover:bg-white"
                          onClick={() => {
                            const profileId =
                              savedNote.patientProfileId ??
                              patientProfiles.find((patientProfile) =>
                                savedNoteMatchesPatientProfile(
                                  savedNote,
                                  patientProfile,
                                ),
                              )?.profileId;

                            if (profileId) {
                              navigateToPatientProfile(profileId);
                            }
                          }}
                          type="button"
                        >
                          Profile
                        </button>
                        <IconButton
                          icon={savedNote.pinned ? "pinOff" : "pin"}
                          label={savedNote.pinned ? "Unpin" : "Pin"}
                          onClick={() => togglePinnedNote(savedNote)}
                        />
                        <IconButton
                          icon="pen"
                          label="Rename"
                          onClick={() => renameSavedNote(savedNote)}
                        />
                        <IconButton
                          danger
                          icon="trash"
                          label="Delete"
                          onClick={() => void deleteSavedNote(savedNote)}
                        />
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ) : activeView === "patient" ? (
            <div className="rounded-2xl border border-zinc-200 p-5">
              {vaultError ? (
                <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
                  {vaultError}
                </div>
              ) : null}

              {selectedPatientProfile ? (
                <div className="space-y-6">
                  <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
                    <div>
                      <p className="text-sm font-semibold text-zinc-500">
                        Patient profile
                      </p>
                      <h2 className="mt-1 text-2xl font-semibold text-zinc-950">
                        {selectedPatientProfile.name}
                      </h2>
                      <p className="mt-2 text-sm text-zinc-500">
                        {formatPatientProfileLabel(selectedPatientProfile)}
                      </p>
                    </div>

                    <button
                      className="rounded-lg border border-zinc-300 px-4 py-2 text-sm font-semibold text-zinc-700 transition hover:border-zinc-400 hover:bg-zinc-50"
                      onClick={() => navigateToView("dashboard")}
                      type="button"
                    >
                      Back to dashboard
                    </button>
                  </div>

                  <dl className="grid gap-3 md:grid-cols-2">
                    <div className="rounded-lg bg-zinc-50 px-4 py-3">
                      <dt className="text-xs font-semibold uppercase tracking-normal text-zinc-500">
                        Patient ID
                      </dt>
                      <dd className="mt-1 text-sm text-zinc-950">
                        {selectedPatientProfile.patientId || "Not documented"}
                      </dd>
                    </div>
                    <div className="rounded-lg bg-zinc-50 px-4 py-3">
                      <dt className="text-xs font-semibold uppercase tracking-normal text-zinc-500">
                        Age
                      </dt>
                      <dd className="mt-1 text-sm text-zinc-950">
                        {selectedPatientProfile.age === undefined
                          ? "Not documented"
                          : selectedPatientProfile.age}
                      </dd>
                    </div>
                    <div className="rounded-lg bg-zinc-50 px-4 py-3">
                      <dt className="text-xs font-semibold uppercase tracking-normal text-zinc-500">
                        Gender
                      </dt>
                      <dd className="mt-1 text-sm text-zinc-950">
                        {selectedPatientProfile.gender || "Not documented"}
                      </dd>
                    </div>
                    <div className="rounded-lg bg-zinc-50 px-4 py-3">
                      <dt className="text-xs font-semibold uppercase tracking-normal text-zinc-500">
                        Saved encounters
                      </dt>
                      <dd className="mt-1 text-sm text-zinc-950">
                        {selectedPatientProfileNotes.length}
                      </dd>
                    </div>
                  </dl>

                  <section>
                    <h3 className="text-lg font-semibold text-zinc-950">
                      Encounters
                    </h3>
                    <div className="mt-4 space-y-3">
                      {selectedPatientProfileNotes.length > 0 ? (
                        selectedPatientProfileNotes.map((savedNote) => (
                          <div
                            className="rounded-xl border border-zinc-200 bg-white px-4 py-3 transition hover:border-zinc-400 hover:bg-zinc-50"
                            key={savedNote.id}
                          >
                            <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
                              <button
                                className="min-w-0 flex-1 text-left"
                                onClick={() => void openSavedNote(savedNote.id)}
                                type="button"
                              >
                                <p className="font-semibold text-zinc-950">
                                  {savedNote.title}
                                </p>
                                <p className="mt-1 text-sm text-zinc-500">
                                  {savedNote.diagnosis
                                    ? `${savedNote.diagnosis} - `
                                    : ""}
                                  {savedNote.visitDate
                                    ? formatDate(savedNote.visitDate)
                                    : formatDate(savedNote.createdAt)}
                                </p>
                              </button>

                              <IconButton
                                icon="pen"
                                label="Open note"
                                onClick={() => void openSavedNote(savedNote.id)}
                              />
                            </div>
                          </div>
                        ))
                      ) : (
                        <p className="rounded-xl bg-zinc-50 px-4 py-3 text-sm text-zinc-500">
                          No saved encounters for this patient yet.
                        </p>
                      )}
                    </div>
                  </section>
                </div>
              ) : (
                <div className="rounded-xl bg-zinc-50 px-4 py-3 text-sm text-zinc-500">
                  Patient profile not found. Return to the dashboard and open a saved profile.
                </div>
              )}
            </div>
          ) : activeView === "scribe" ? (
            <>

          <textarea
            className="min-h-72 w-full resize-none rounded-2xl border border-zinc-200 bg-zinc-50 p-4 text-base leading-7 text-zinc-900 shadow-inner outline-none transition focus:border-zinc-400 focus:bg-white focus:ring-4 focus:ring-zinc-100"
            onChange={(event) => {
              setTranscript(event.target.value);
              setNoteResult(null);
              setBaseNoteResult(null);
              resetNoteChat();
              setCurrentNoteTranscript("");
              setCurrentNoteTitle("");
              setCurrentEncounterId("");
              setPatientDraft(getPatientDraftFromNote(null));
              setPatientRecordStatus("");
              setActiveNoteLanguage("Original");
              setSelectedTranslationLanguage("");
              setTranslationStatus("");
            }}
            placeholder="Transcript will appear here..."
            value={transcript}
          />

          {error ? (
            <div className="mt-4 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
              {error}
            </div>
          ) : null}

          <div className="mt-4 flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
            <div>
              <p className="text-sm text-zinc-500">
                {isRecording ? "Recording in progress" : status}
                {isUploading ? "..." : ""}
              </p>
              <p className="mt-1 text-xs text-zinc-400">{autosaveStatus}</p>
              {pendingRecordings.length > 0 ? (
                <p className="mt-1 text-xs text-zinc-400">
                  Recorded clips ready to save: {pendingRecordings.length}
                </p>
              ) : null}
            </div>

            <div className="flex flex-wrap gap-2">
              <IconButton
                disabled={
                  !hasCurrentDraft ||
                  isRecording ||
                  isUploading ||
                  isGeneratingNote
                }
                icon="eraser"
                label="Clear transcript"
                onClick={clearCurrentTranscript}
              />

              <IconButton
                disabled={isUploading}
                icon={isRecording ? "stop" : "mic"}
                label={isRecording ? "Stop recording" : "Start recording"}
                onClick={handleButtonClick}
              />

              <button
                className="rounded-lg bg-zinc-950 px-5 py-3 text-sm font-semibold text-white shadow-sm transition hover:bg-zinc-800 disabled:cursor-not-allowed disabled:bg-zinc-400"
                disabled={
                  isRecording ||
                  isUploading ||
                  isGeneratingNote ||
                  transcript.trim().length === 0
                }
                onClick={() => void generateNote()}
                type="button"
              >
                {isGeneratingNote ? "Generating..." : "Generate Note"}
              </button>
            </div>
          </div>

          {noteError ? (
            <div className="mt-5 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
              {noteError}
            </div>
          ) : null}
            </>
          ) : null}
        </div>

        {activeView === "note" ? (
        <div className="rounded-[2rem] border border-zinc-200 bg-white p-6 shadow-sm sm:p-8">
          <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
            <div>
              <h2 className="text-xl font-semibold tracking-normal text-zinc-950">
                Clinical note
              </h2>
            </div>

            <div className="flex flex-wrap gap-2">
              {noteResult ? (
                <button
                  className="rounded-lg bg-zinc-950 px-4 py-2 text-sm font-semibold text-white shadow-sm transition hover:bg-zinc-800"
                  onClick={exportCurrentNotePdf}
                  type="button"
                >
                  Export PDF
                </button>
              ) : null}

              <button
                className="rounded-lg border border-zinc-300 px-4 py-2 text-sm font-semibold text-zinc-700 transition hover:border-zinc-400 hover:bg-zinc-50"
                onClick={() => navigateToView("scribe")}
                type="button"
              >
                Return home
              </button>
            </div>
          </div>

          {noteError ? (
            <div className="mt-5 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
              {noteError}
            </div>
          ) : null}

          {noteResult ? (
            <div
              className="mt-6 space-y-6"
              onKeyUp={updateSelectedNoteText}
              onMouseUp={updateSelectedNoteText}
              ref={noteContentRef}
            >
              <section className="rounded-2xl border border-zinc-200 p-5">
                <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
                  <div>
                    <p className="text-sm font-semibold text-zinc-500">
                      {activeNoteLabel}
                    </p>
                    <h3 className="mt-1 text-lg font-semibold text-zinc-950">
                      {displayedNoteHeading}
                    </h3>
                    {translationStatus ? (
                      <p className="mt-1 text-sm text-zinc-500">
                        {translationStatus}
                      </p>
                    ) : null}
                  </div>

                  {currentNoteId ? (
                    <div className="flex flex-col gap-2 sm:flex-row sm:items-start">
                      <div className="relative sm:w-64">
                        <button
                          className={`w-full rounded-lg border px-3 py-2 text-left text-sm font-semibold transition disabled:cursor-not-allowed ${
                            isTranslating
                              ? "border-zinc-200 bg-zinc-100 text-zinc-400"
                              : "border-zinc-300 text-zinc-700 hover:border-zinc-400 hover:bg-zinc-50"
                          }`}
                          disabled={isTranslating}
                          onClick={() =>
                            setIsLanguagePickerOpen((current) => !current)
                          }
                          type="button"
                        >
                          <span className="block truncate">
                            {selectedLanguageLabel}
                          </span>
                        </button>

                        {isLanguagePickerOpen ? (
                          <div className="absolute right-0 z-10 mt-2 w-64 rounded-xl border border-zinc-200 bg-white p-3 shadow-lg">
                            <input
                              className="w-full rounded-lg border border-zinc-200 bg-zinc-50 px-3 py-2 text-sm outline-none transition disabled:cursor-not-allowed disabled:bg-zinc-100 disabled:text-zinc-400 focus:border-zinc-400 focus:bg-white"
                              disabled={isTranslating}
                              onChange={(event) =>
                                setLanguageSearch(event.target.value)
                              }
                              placeholder="Search language..."
                              value={languageSearch}
                            />
                            <div className="mt-2 max-h-56 overflow-y-auto">
                              {filteredLanguages.length > 0 ? (
                                filteredLanguages.map((language) => (
                                  <button
                                    className={`block w-full rounded-lg px-3 py-2 text-left text-sm transition disabled:cursor-not-allowed disabled:text-zinc-400 ${
                                      selectedTranslationLanguage === language
                                        ? "bg-zinc-100 font-semibold text-zinc-950"
                                        : "text-zinc-700 hover:bg-zinc-50"
                                    }`}
                                    disabled={isTranslating}
                                    key={language}
                                    onClick={() =>
                                      selectTranslationLanguage(language)
                                    }
                                    type="button"
                                  >
                                    {language}
                                    {originalNoteLanguage &&
                                    getLanguageKey(language) ===
                                      getLanguageKey(originalNoteLanguage) ? (
                                      <span className="ml-2 text-xs text-zinc-400">
                                        original saved
                                      </span>
                                    ) : savedNoteLanguages.some(
                                        (savedLanguage) =>
                                          getLanguageKey(savedLanguage) ===
                                          getLanguageKey(language),
                                      ) ? (
                                      <span className="ml-2 text-xs text-zinc-400">
                                        saved
                                      </span>
                                    ) : null}
                                  </button>
                                ))
                              ) : (
                                <p className="px-3 py-2 text-sm text-zinc-500">
                                  No matching languages.
                                </p>
                              )}
                            </div>
                          </div>
                        ) : null}
                      </div>

                      <button
                        className="rounded-lg bg-zinc-950 px-4 py-2 text-sm font-semibold text-white shadow-sm transition hover:bg-zinc-800 disabled:cursor-not-allowed disabled:bg-zinc-300"
                        disabled={isTranslating || !selectedTranslationLanguage}
                        onClick={translateSelectedLanguage}
                        type="button"
                      >
                        {translateButtonLabel}
                      </button>
                    </div>
                  ) : null}
                </div>

                {showDebugPanel ? (
                  <div className="mt-4 rounded-xl bg-zinc-950 px-4 py-3 text-sm text-zinc-100">
                    <p>Debug panel</p>
                    <p className="mt-1 text-zinc-300">
                      Provider: {getProviderLabel(noteResult.provider_used) || "Unknown"}
                    </p>
                    <p className="text-zinc-300">
                      Language: {asText(noteResult.language_detected)}
                    </p>
                    <p className="text-zinc-300">
                      Note ID: {currentNoteId || "Unsaved"}
                    </p>
                  </div>
                ) : null}
              </section>

              <section className="rounded-2xl border border-zinc-200 p-5">
                <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
                  <div>
                    <h3 className="text-lg font-semibold text-zinc-950">
                      Detected patient info
                    </h3>
                    <p className="mt-1 text-sm text-zinc-500">
                      Review or edit these fields. Changes autosave to the dashboard.
                    </p>
                  </div>

                  <p className="rounded-lg bg-zinc-50 px-3 py-2 text-sm text-zinc-600">
                    {isSavingPatientRecord
                      ? "Autosaving..."
                      : patientRecordStatus || "Autosave ready"}
                  </p>
                </div>

                <div className="mt-4 rounded-xl bg-zinc-50 p-4">
                  <div className="grid gap-3 lg:grid-cols-[1fr_auto_auto] lg:items-end">
                    <label className="block text-sm font-medium text-zinc-700">
                      Assign patient profile
                      <select
                        className="mt-2 w-full rounded-lg border border-zinc-200 bg-white px-3 py-2 text-zinc-950 outline-none transition focus:border-zinc-400 focus:ring-4 focus:ring-zinc-100"
                        onChange={(event) => assignPatientProfile(event.target.value)}
                        value={patientDraft.patientProfileId ?? ""}
                      >
                        <option value="">No assigned profile</option>
                        {patientProfiles.map((profile) => (
                          <option key={profile.profileId} value={profile.profileId}>
                            {formatPatientProfileLabel(profile)}
                          </option>
                        ))}
                      </select>
                    </label>

                    <button
                      className="rounded-lg border border-zinc-300 px-4 py-2 text-sm font-semibold text-zinc-700 transition hover:border-zinc-400 hover:bg-white disabled:cursor-not-allowed disabled:text-zinc-400"
                      disabled={isSavingPatientProfile || !patientDraft.name.trim()}
                      onClick={() => void createPatientProfileFromDraft()}
                      type="button"
                    >
                      {isSavingPatientProfile ? "Creating..." : "Create new profile"}
                    </button>

                    <button
                      className="rounded-lg border border-zinc-300 px-4 py-2 text-sm font-semibold text-zinc-700 transition hover:border-zinc-400 hover:bg-white disabled:cursor-not-allowed disabled:text-zinc-400"
                      disabled={!assignedPatientProfile}
                      onClick={() => {
                        if (assignedPatientProfile) {
                          navigateToPatientProfile(assignedPatientProfile.profileId);
                        }
                      }}
                      type="button"
                    >
                      View profile
                    </button>
                  </div>

                  <p className="mt-3 text-xs text-zinc-500">
                    {assignedPatientProfile
                      ? `Assigned to ${formatPatientProfileLabel(assignedPatientProfile)}.`
                      : "Choose an existing patient or create a profile from the fields below."}
                  </p>
                </div>

                <div className="mt-4 grid gap-4 md:grid-cols-2">
                  <label className="block text-sm font-medium text-zinc-700">
                    Patient name
                    <input
                      className="mt-2 w-full rounded-lg border border-zinc-200 bg-zinc-50 px-3 py-2 text-zinc-950 outline-none transition focus:border-zinc-400 focus:bg-white focus:ring-4 focus:ring-zinc-100"
                      onChange={(event) =>
                        setPatientDraft((current) => ({
                          ...current,
                          name: event.target.value,
                        }))
                      }
                      placeholder="Unknown patient"
                      type="text"
                      value={patientDraft.name}
                    />
                  </label>

                  <label className="block text-sm font-medium text-zinc-700">
                    Patient ID
                    <input
                      className="mt-2 w-full rounded-lg border border-zinc-200 bg-zinc-50 px-3 py-2 text-zinc-950 outline-none transition focus:border-zinc-400 focus:bg-white focus:ring-4 focus:ring-zinc-100"
                      onChange={(event) =>
                        setPatientDraft((current) => ({
                          ...current,
                          patientId: event.target.value,
                        }))
                      }
                      placeholder="MRN or clinic ID"
                      type="text"
                      value={patientDraft.patientId}
                    />
                  </label>

                  <label className="block text-sm font-medium text-zinc-700">
                    Age
                    <input
                      className="mt-2 w-full rounded-lg border border-zinc-200 bg-zinc-50 px-3 py-2 text-zinc-950 outline-none transition focus:border-zinc-400 focus:bg-white focus:ring-4 focus:ring-zinc-100"
                      max="130"
                      min="0"
                      onChange={(event) =>
                        setPatientDraft((current) => ({
                          ...current,
                          age: event.target.value,
                        }))
                      }
                      placeholder="Age"
                      type="number"
                      value={patientDraft.age}
                    />
                  </label>

                  <label className="block text-sm font-medium text-zinc-700">
                    Gender
                    <input
                      className="mt-2 w-full rounded-lg border border-zinc-200 bg-zinc-50 px-3 py-2 text-zinc-950 outline-none transition focus:border-zinc-400 focus:bg-white focus:ring-4 focus:ring-zinc-100"
                      onChange={(event) =>
                        setPatientDraft((current) => ({
                          ...current,
                          gender: event.target.value,
                        }))
                      }
                      placeholder="Not documented"
                      type="text"
                      value={patientDraft.gender}
                    />
                  </label>

                  <label className="block text-sm font-medium text-zinc-700">
                    Visit date
                    <input
                      className="mt-2 w-full rounded-lg border border-zinc-200 bg-zinc-50 px-3 py-2 text-zinc-950 outline-none transition focus:border-zinc-400 focus:bg-white focus:ring-4 focus:ring-zinc-100"
                      onChange={(event) =>
                        setPatientDraft((current) => ({
                          ...current,
                          visitDate: event.target.value,
                        }))
                      }
                      type="date"
                      value={patientDraft.visitDate}
                    />
                  </label>

                  <label className="block text-sm font-medium text-zinc-700 md:col-span-2">
                    Diagnosis
                    <input
                      className="mt-2 w-full rounded-lg border border-zinc-200 bg-zinc-50 px-3 py-2 text-zinc-950 outline-none transition focus:border-zinc-400 focus:bg-white focus:ring-4 focus:ring-zinc-100"
                      onChange={(event) =>
                        setPatientDraft((current) => ({
                          ...current,
                          diagnosis: event.target.value,
                        }))
                      }
                      placeholder="Not documented"
                      type="text"
                      value={patientDraft.diagnosis}
                    />
                  </label>
                </div>

              </section>

              {hasCurrentNoteTranscript || currentNoteRecordings.length > 0 ? (
                <details className="group rounded-2xl border border-zinc-200 p-5">
                  <summary className="flex cursor-pointer list-none items-center justify-between gap-4 text-lg font-semibold text-zinc-950 marker:hidden">
                    <span>Transcript and recordings</span>
                    <span className="text-sm font-medium text-zinc-500">
                      {noteSourceMaterialsLabel}
                    </span>
                  </summary>

                  <div className="mt-5 space-y-5 border-t border-zinc-200 pt-5">
                    {hasCurrentNoteTranscript ? (
                      <div>
                        <h3 className="text-sm font-semibold text-zinc-900">
                          Saved transcript
                        </h3>
                        <p className="mt-3 whitespace-pre-wrap rounded-lg bg-zinc-50 p-4 text-sm leading-6 text-zinc-700">
                          {currentNoteTranscript}
                        </p>
                      </div>
                    ) : null}

                    {currentNoteRecordings.length > 0 ? (
                      <div>
                        <h3 className="text-sm font-semibold text-zinc-900">
                          Recorded audio
                        </h3>
                        <div className="mt-3 space-y-3">
                          {currentNoteRecordings.map((recording, index) => (
                            <div
                              className="rounded-lg border border-zinc-200 bg-zinc-50 p-3"
                              key={recording.id}
                            >
                              <p className="text-sm font-semibold text-zinc-900">
                                Recording {index + 1}
                              </p>
                              <p className="mt-1 text-xs text-zinc-500">
                                {formatDate(recording.createdAt)} -{" "}
                                {Math.max(1, Math.round(recording.size / 1024))} KB
                              </p>
                              {recording.dataUrl ? (
                                <audio
                                  className="mt-3 w-full"
                                  controls
                                  preload="metadata"
                                  src={recording.dataUrl}
                                />
                              ) : (
                                <p className="mt-3 text-sm text-zinc-500">
                                  Audio file saved without an inline preview.
                                </p>
                              )}
                            </div>
                          ))}
                        </div>
                      </div>
                    ) : null}
                  </div>
                </details>
              ) : null}

              <section className="rounded-2xl border border-zinc-200 p-5">
                <h3 className="mb-4 text-lg font-semibold text-zinc-950">SOAP</h3>

                <div className="grid gap-4 md:grid-cols-2">
                  <div>
                    <p className="text-sm font-semibold text-zinc-900">Subjective</p>
                    {renderBulletText(noteResult.soap?.subjective)}
                  </div>
                  <div>
                    <p className="text-sm font-semibold text-zinc-900">Objective</p>
                    {renderBulletText(noteResult.soap?.objective)}
                  </div>
                  <div>
                    <p className="text-sm font-semibold text-zinc-900">Assessment</p>
                    {renderBulletText(noteResult.soap?.assessment)}
                  </div>
                  <div>
                    <p className="text-sm font-semibold text-zinc-900">Plan</p>
                    {renderNumberedText(noteResult.soap?.plan)}
                  </div>
                </div>
              </section>

              <section className="rounded-2xl border border-zinc-200 p-5">
                <h3 className="text-lg font-semibold text-zinc-950">Visit Summary</h3>
                <p className="mt-2 whitespace-pre-wrap text-sm leading-6 text-zinc-700">
                  {asText(noteResult.visit_summary)}
                </p>
              </section>

              <section className="rounded-2xl border border-zinc-200 p-5">
                <h3 className="text-lg font-semibold text-zinc-950">Extracted Data</h3>
                <div className="mt-4 grid gap-4 md:grid-cols-2">
                  <div>
                    <p className="mb-2 text-sm font-semibold text-zinc-900">Symptoms</p>
                    {renderList(noteResult.extracted?.symptoms)}
                  </div>
                  <div>
                    <p className="mb-2 text-sm font-semibold text-zinc-900">Medications</p>
                    {renderList(noteResult.extracted?.medications)}
                  </div>
                  <div>
                    <p className="mb-2 text-sm font-semibold text-zinc-900">
                      Follow-up Plan
                    </p>
                    {renderList(noteResult.extracted?.follow_up_plan)}
                  </div>
                  <div>
                    <p className="mb-2 text-sm font-semibold text-zinc-900">Red Flags</p>
                    {renderList(noteResult.extracted?.red_flags)}
                  </div>
                  <div className="md:col-span-2">
                    <p className="mb-2 text-sm font-semibold text-zinc-900">
                      Uncertainties
                    </p>
                    {renderList(noteResult.uncertainties)}
                  </div>
                </div>
              </section>

              <section className="rounded-2xl border border-zinc-200 p-5">
                <h3 className="text-lg font-semibold text-zinc-950">
                  Discharge Instructions
                </h3>
                <p className="mt-2 whitespace-pre-wrap text-sm leading-6 text-zinc-700">
                  {asText(noteResult.discharge_instructions)}
                </p>
              </section>
            </div>
          ) : (
            <div className="mt-6 rounded-2xl border border-zinc-200 bg-zinc-50 p-5 text-sm text-zinc-500">
              Generate a note from Home to review it here.
            </div>
          )}
        </div>
        ) : null}
      </section>

      {activeView === "note" && noteResult ? (
        <>
          <aside
            aria-hidden={!isNoteChatOpen}
            inert={!isNoteChatOpen ? true : undefined}
            className={`fixed bottom-20 left-4 z-30 flex h-[min(82vh,44rem)] max-h-[calc(100vh-6rem)] w-[calc(100vw-2rem)] max-w-lg origin-bottom-left flex-col rounded-2xl border border-zinc-200 bg-white shadow-xl transition-all duration-200 ease-out motion-reduce:transform-none motion-reduce:transition-none sm:left-6 ${
              isNoteChatOpen
                ? "translate-y-0 scale-100 opacity-100"
                : "pointer-events-none translate-y-4 scale-95 opacity-0"
            }`}
          >
              <div className="flex items-start justify-between gap-3 border-b border-zinc-200 px-4 py-3">
                <div>
                  <p className="text-sm font-semibold text-zinc-950">
                    ClinicScribe AI
                  </p>
                  <p className="mt-1 text-xs text-zinc-500">
                    Ask questions or request edits. Highlight note text to target a section.
                  </p>
                </div>
                <div className="flex shrink-0 gap-2">
                  <button
                    className="rounded-lg border border-zinc-300 px-3 py-2 text-xs font-semibold text-zinc-700 transition hover:border-zinc-400 hover:bg-zinc-50 disabled:cursor-not-allowed disabled:text-zinc-400"
                    disabled={noteChatMessages.length === 0 || isEditingNoteWithAi}
                    onClick={clearNoteChatHistory}
                    title="Clear chat history"
                    type="button"
                  >
                    Clear
                  </button>
                  <IconButton
                    disabled={isEditingNoteWithAi}
                    icon="x"
                    label="Close ClinicScribe AI chat"
                    onClick={() => setIsNoteChatOpen(false)}
                  />
                </div>
              </div>

              <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-4 py-4">
                {noteChatMessages.length > 0 ? (
                  noteChatMessages.map((message) => (
                    <div
                      className={`flex ${
                        message.role === "user" ? "justify-end" : "justify-start"
                      }`}
                      key={message.id}
                    >
                      <div
                        className={`max-w-[85%] rounded-xl px-3 py-2 text-sm leading-6 ${
                          message.role === "user"
                            ? "bg-zinc-950 text-white"
                            : "bg-zinc-100 text-zinc-800"
                        }`}
                      >
                        {message.selectedText ? (
                          <p className="mb-2 border-b border-current/20 pb-2 text-xs opacity-80">
                            Selection: {message.selectedText}
                          </p>
                        ) : null}
                        <p className="whitespace-pre-wrap">{message.content}</p>
                      </div>
                    </div>
                  ))
                ) : (
                  <div className="rounded-xl bg-zinc-50 px-3 py-3 text-sm leading-6 text-zinc-500">
                    Try: "What should I check next?" or highlight one sentence and ask me to rewrite it.
                  </div>
                )}

                {isEditingNoteWithAi ? (
                  <p className="text-sm text-zinc-500">Editing note...</p>
                ) : null}
                <div ref={noteChatMessagesEndRef} />
              </div>

              {noteChatError ? (
                <div className="border-t border-red-100 bg-red-50 px-4 py-3 text-sm text-red-700">
                  {noteChatError}
                </div>
              ) : null}

              <form
                className="border-t border-zinc-200 p-3"
                onSubmit={(event) => {
                  event.preventDefault();
                  void sendNoteChatMessage();
                }}
              >
                <label className="sr-only" htmlFor="note-chat-message">
                  Message ClinicScribe AI
                </label>
                <div className="rounded-lg border border-zinc-200 bg-zinc-50 transition focus-within:border-zinc-400 focus-within:bg-white focus-within:ring-4 focus-within:ring-zinc-100">
                  {selectedNoteText ? (
                    <div className="border-b border-zinc-200 px-3 py-2 text-xs leading-5 text-zinc-600">
                      <p className="font-semibold text-zinc-800">
                        Selected note text
                      </p>
                      <p className="mt-1 line-clamp-2">{selectedNoteText}</p>
                    </div>
                  ) : null}
                  <textarea
                    className="max-h-28 min-h-16 w-full resize-none bg-transparent px-3 py-3 text-sm text-zinc-950 outline-none disabled:cursor-not-allowed disabled:text-zinc-400"
                    disabled={isEditingNoteWithAi}
                    id="note-chat-message"
                    onChange={(event) => setNoteChatInput(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" && !event.shiftKey) {
                        event.preventDefault();
                        void sendNoteChatMessage();
                      }
                    }}
                    placeholder="Ask or tell ClinicScribe AI what to change..."
                    value={noteChatInput}
                  />
                </div>
                <div className="mt-3 flex items-center justify-between gap-3">
                  <p className="text-xs text-zinc-500">
                    Enter sends. Shift+Enter adds a line.
                  </p>
                  <button
                    className="inline-flex items-center gap-2 rounded-lg bg-zinc-950 px-4 py-2 text-sm font-semibold text-white shadow-sm transition hover:bg-zinc-800 disabled:cursor-not-allowed disabled:bg-zinc-300"
                    disabled={isEditingNoteWithAi || !noteChatInput.trim()}
                    title="Send message"
                    type="submit"
                  >
                    <Icon name="send" />
                    Send
                  </button>
                </div>
              </form>
          </aside>

          <button
            aria-label="Open ClinicScribe AI chat"
            className="fixed bottom-5 left-4 z-30 inline-flex h-12 w-12 items-center justify-center rounded-lg border border-zinc-300 bg-white text-zinc-800 shadow-lg transition hover:border-zinc-400 hover:bg-zinc-50 sm:left-6"
            onClick={() => {
              setIsNoteChatOpen((current) => !current);
              setNoteChatError("");
            }}
            title="ClinicScribe AI"
            type="button"
          >
            <Icon name="chat" />
          </button>
        </>
      ) : null}
    </main>
  );
}

export default App;
