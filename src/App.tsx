import { type FormEvent, useEffect, useRef, useState } from "react";

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
  language_detected?: unknown;
  provider_used?: unknown;
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
};

type AuthMode = "login" | "signup";

type AuthResponse = {
  user?: CurrentUser;
  error?: string;
};

type AppView = "scribe" | "dashboard" | "note";

type SavedNoteSummary = {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
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

type SavedNoteDetail = {
  id: string;
  title: string;
  transcript: string;
  createdAt: string;
  updatedAt: string;
  pinned?: boolean;
  pinnedAt?: string;
  result: NoteResult;
  recordings?: NoteRecording[];
  translations?: Record<
    string,
    {
      language: string;
      note: NoteResult;
      provider_used: string;
      createdAt: string;
      updatedAt: string;
    }
  >;
};

type NotesResponse = {
  notes?: SavedNoteSummary[];
  note?: SavedNoteDetail;
  error?: string;
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
const BRAND_LOGO_SRC = "/brand/logo.png?v=2";

const VIEW_PATHS: Record<AppView, string> = {
  scribe: "/",
  dashboard: "/dashboard",
  note: "/note",
};

const getViewFromPathname = (pathname: string): AppView => {
  const normalizedPath = pathname.replace(/\/+$/, "") || "/";

  if (normalizedPath === VIEW_PATHS.dashboard) {
    return "dashboard";
  }

  if (normalizedPath === VIEW_PATHS.note) {
    return "note";
  }

  return "scribe";
};

const getAutosaveKey = (userId: string) => `clinicscribe.autosave.${userId}`;

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

const getSavedNoteSummary = (
  note: NoteResult | null,
  fallbackTitle = "",
): SavedNoteSummary | null => {
  const id = getNoteId(note);

  if (!id) {
    return null;
  }

  const savedAt = getStringValue(note?.saved_at);
  const updatedAt = getStringValue(note?.updated_at) || savedAt;
  const now = new Date().toISOString();

  return {
    id,
    title: fallbackTitle || getStringValue(note?.title) || "Clinic note",
    createdAt: savedAt || updatedAt || now,
    updatedAt: updatedAt || savedAt || now,
    language_detected: getStringValue(note?.language_detected) || undefined,
    provider_used: getStringValue(note?.provider_used) || undefined,
    recording_count: getNoteRecordings(note).length,
    pinned: note?.pinned === true,
    pinnedAt: getStringValue(note?.pinned_at) || undefined,
    translation_languages: getTranslationLanguages(note),
  };
};

const upsertSavedNoteSummary = (
  notes: SavedNoteSummary[],
  note: SavedNoteSummary,
) => sortSavedNotes([note, ...notes.filter((savedNote) => savedNote.id !== note.id)]);

const sortSavedNotes = (notes: SavedNoteSummary[]) =>
  [...notes].sort((left, right) => {
    if (left.pinned !== right.pinned) {
      return left.pinned ? -1 : 1;
    }

    return Date.parse(right.updatedAt) - Date.parse(left.updatedAt);
  });

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
  const [pendingRecordings, setPendingRecordings] = useState<NoteRecording[]>([]);
  const [currentNoteRecordings, setCurrentNoteRecordings] = useState<
    NoteRecording[]
  >([]);
  const [activeNoteLanguage, setActiveNoteLanguage] = useState("Original");
  const [activeView, setActiveView] = useState<AppView>(() =>
    getViewFromPathname(window.location.pathname),
  );
  const [savedNotes, setSavedNotes] = useState<SavedNoteSummary[]>([]);
  const [isLoadingNotes, setIsLoadingNotes] = useState(false);
  const [vaultError, setVaultError] = useState("");
  const [languageSearch, setLanguageSearch] = useState("");
  const [isLanguagePickerOpen, setIsLanguagePickerOpen] = useState(false);
  const [selectedTranslationLanguage, setSelectedTranslationLanguage] =
    useState("");
  const [isTranslating, setIsTranslating] = useState(false);
  const [translationStatus, setTranslationStatus] = useState("");
  const [showDebugPanel, setShowDebugPanel] = useState(false);
  const [noteError, setNoteError] = useState("");
  const [isGeneratingNote, setIsGeneratingNote] = useState(false);
  const [hasHydratedAutosave, setHasHydratedAutosave] = useState(false);
  const [autosaveStatus, setAutosaveStatus] = useState("Autosave ready");

  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<BlobPart[]>([]);
  const suppressNextAutosaveRef = useRef(false);

  const cleanupRecording = () => {
    mediaStreamRef.current?.getTracks().forEach((track) => track.stop());
    mediaStreamRef.current = null;
    mediaRecorderRef.current = null;
    chunksRef.current = [];
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
      const response = await fetch("/api/auth", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        credentials: "same-origin",
        body: JSON.stringify({
          action: authMode,
          email: authEmail,
          password: authPassword,
          ...(authMode === "signup" ? { name: authName } : {}),
        }),
      });
      const responseJson = (await parseJsonResponse(
        response,
        "The auth endpoint returned invalid JSON.",
      )) as AuthResponse;

      if (!response.ok || !responseJson.user) {
        throw new Error(
          getErrorMessage(
            responseJson,
            authMode === "signup"
              ? "Unable to create account."
              : "Unable to sign in.",
          ),
        );
      }

      setCurrentUser(responseJson.user);
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
      const response = await fetch("/api/auth", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        credentials: "same-origin",
        body: JSON.stringify({ action: "logout" }),
      });
      const responseJson = await parseJsonResponse(
        response,
        "The auth endpoint returned invalid JSON.",
      );

      if (!response.ok) {
        throw new Error(getErrorMessage(responseJson, "Unable to sign out."));
      }

      cleanupRecording();
      setCurrentUser(null);
      setTranscript("");
      setNoteResult(null);
      setBaseNoteResult(null);
      setCurrentNoteTranscript("");
      setPendingRecordings([]);
      setCurrentNoteRecordings([]);
      setSavedNotes([]);
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
      const response = await fetch("/api/notes", {
        credentials: "same-origin",
      });
      const responseJson = (await parseJsonResponse(
        response,
        "The notes endpoint returned invalid JSON.",
      )) as NotesResponse;

      if (!response.ok || !Array.isArray(responseJson.notes)) {
        throw new Error(getErrorMessage(responseJson, "Unable to load note vault."));
      }

      const openNoteSummary = getSavedNoteSummary(
        baseNoteResult ?? noteResult,
        currentNoteTitle,
      );
      const notes = openNoteSummary
        ? upsertSavedNoteSummary(responseJson.notes, openNoteSummary)
        : sortSavedNotes(responseJson.notes);

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

  const navigateToView = (view: AppView) => {
    const nextPath = VIEW_PATHS[view];

    if (window.location.pathname !== nextPath) {
      window.history.pushState(null, "", nextPath);
    }

    setActiveView(view);

    if (view === "dashboard") {
      void loadSavedNotes();
    }
  };

  const openSavedNote = async (noteId: string) => {
    setVaultError("");

    try {
      const response = await fetch(`/api/notes?id=${encodeURIComponent(noteId)}`, {
        credentials: "same-origin",
      });
      const responseJson = (await parseJsonResponse(
        response,
        "The notes endpoint returned invalid JSON.",
      )) as NotesResponse;

      if (!response.ok || !responseJson.note) {
        throw new Error(getErrorMessage(responseJson, "Unable to open saved note."));
      }

      const note = responseJson.note;

      setBaseNoteResult(note.result);
      setNoteResult(note.result);
      setCurrentNoteTitle(note.title);
      setCurrentNoteTranscript(note.transcript);
      setPendingRecordings([]);
      setCurrentNoteRecordings(note.recordings ?? []);
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
      const response = await fetch("/api/notes", {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
        },
        credentials: "same-origin",
        body: JSON.stringify({ id: noteId, ...updates }),
      });
      const responseJson = (await parseJsonResponse(
        response,
        "The notes endpoint returned invalid JSON.",
      )) as { note?: SavedNoteSummary; error?: string };

      if (!response.ok || !responseJson.note) {
        throw new Error(getErrorMessage(responseJson, "Unable to update saved note."));
      }

      const updatedNote = responseJson.note;

      setSavedNotes((currentNotes) =>
        upsertSavedNoteSummary(currentNotes, updatedNote),
      );

      if (getNoteId(baseNoteResult ?? noteResult) === noteId) {
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
      const response = await fetch(`/api/notes?id=${encodeURIComponent(note.id)}`, {
        method: "DELETE",
        credentials: "same-origin",
      });
      const responseJson = await parseJsonResponse(
        response,
        "The notes endpoint returned invalid JSON.",
      );

      if (!response.ok) {
        throw new Error(getErrorMessage(responseJson, "Unable to delete saved note."));
      }

      setSavedNotes((currentNotes) =>
        currentNotes.filter((savedNote) => savedNote.id !== note.id),
      );

      if (getNoteId(baseNoteResult ?? noteResult) === note.id) {
        setNoteResult(null);
        setBaseNoteResult(null);
        setCurrentNoteRecordings([]);
        setCurrentNoteTranscript("");
        setCurrentNoteTitle("");
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
      const response = await fetch("/api/translate-note", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        credentials: "same-origin",
        body: JSON.stringify({ noteId, language, force }),
      });
      const responseJson = (await parseJsonResponse(
        response,
        "The translation endpoint returned invalid JSON.",
      )) as TranslateResponse;

      if (!response.ok || !responseJson.result || !responseJson.language) {
        throw new Error(getErrorMessage(responseJson, "Unable to translate note."));
      }

      const nextTranslationLanguages = getTranslationLanguages(responseJson.result);

      setNoteResult(responseJson.result);
      setBaseNoteResult((current) =>
        current
          ? {
              ...current,
              translation_languages: nextTranslationLanguages,
            }
          : current,
      );
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

  const transcribeAudio = async (audioBlob: Blob) => {
    setIsUploading(true);
    setStatus("Uploading audio");

    try {
      const formData = new FormData();
      const file = new File([audioBlob], getAudioFileName(audioBlob.type), {
        type: audioBlob.type || "audio/webm",
      });

      formData.set("audio", file);

      const response = await fetch("/api/transcribe", {
        method: "POST",
        credentials: "same-origin",
        body: formData,
      });

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
      setCurrentNoteRecordings([]);
      setCurrentNoteTranscript("");
      setCurrentNoteTitle("");
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

    try {
      const response = await fetch("/api/make-note", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        credentials: "same-origin",
        body: JSON.stringify({
          transcript: transcriptForNote,
          recordings: pendingRecordings.map((recording) => ({
            id: recording.id,
            transcript: recording.transcript,
          })),
        }),
      });

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
      const savedNoteSummary = getSavedNoteSummary(generatedNote);

      if (!savedNoteSummary) {
        throw new Error(
          "The note was generated, but the server did not return a saved note ID.",
        );
      }

      setNoteResult(generatedNote);
      setBaseNoteResult(generatedNote);
      setCurrentNoteTranscript(transcriptForNote);
      setTranscript("");
      setPendingRecordings([]);
      setCurrentNoteRecordings(getNoteRecordings(generatedNote));
      setCurrentNoteTitle(getStringValue(generatedNote.title));
      setActiveNoteLanguage("Original");
      setSelectedTranslationLanguage("");
      setTranslationStatus("Saved to your note vault.");
      setStatus("Ready");
      setAutosaveStatus("Transcript cleared after saving");
      navigateToView("note");
      setSavedNotes((currentNotes) =>
        upsertSavedNoteSummary(currentNotes, savedNoteSummary),
      );

      const loadedNotes = await loadSavedNotes();

      if (!loadedNotes.some((savedNote) => savedNote.id === savedNoteSummary.id)) {
        setSavedNotes((currentNotes) =>
          upsertSavedNoteSummary(currentNotes, savedNoteSummary),
        );
      }
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

  useEffect(() => {
    let isMounted = true;

    const checkAuth = async () => {
      try {
        const response = await fetch("/api/auth", {
          credentials: "same-origin",
        });

        if (response.status === 401) {
          if (isMounted) {
            setCurrentUser(null);
          }

          return;
        }

        const responseJson = (await parseJsonResponse(
          response,
          "The auth endpoint returned invalid JSON.",
        )) as AuthResponse;

        if (!response.ok || !responseJson.user) {
          throw new Error(
            getErrorMessage(responseJson, "Unable to check your session."),
          );
        }

        if (isMounted) {
          setCurrentUser(responseJson.user);
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

    return () => {
      isMounted = false;
    };
  }, []);

  useEffect(() => {
    if (!currentUser) {
      return;
    }

    void loadSavedNotes();
  }, [currentUser]);

  useEffect(() => {
    const handlePopState = () => {
      const nextView = getViewFromPathname(window.location.pathname);

      setActiveView(nextView);

      if (currentUser && nextView === "dashboard") {
        void loadSavedNotes();
      }
    };

    window.addEventListener("popstate", handlePopState);

    return () => {
      window.removeEventListener("popstate", handlePopState);
    };
  }, [currentUser]);

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
    currentUser,
    hasHydratedAutosave,
    noteResult,
    pendingRecordings,
    selectedTranslationLanguage,
    transcript,
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
  const pageTitle =
    activeView === "dashboard"
      ? "Note vault"
      : activeView === "note"
        ? "Clinical note"
        : "ClinicScribe";
  const pageDescription =
    activeView === "dashboard"
      ? "Your saved ClinicScribe notes stay tied to this account."
      : activeView === "note"
        ? noteHeading || "Review the generated documentation."
        : "Clinical notes faster, clearer, and ready for review.";

  return (
    <main className="min-h-screen bg-zinc-100 px-4 py-8 text-zinc-950 sm:px-6 lg:px-8">
      <section className="mx-auto flex max-w-5xl flex-col gap-6">
        <div className="rounded-[2rem] border border-zinc-200 bg-white p-6 shadow-sm sm:p-8">
          <div className="mb-6 flex flex-col gap-5 lg:flex-row lg:items-start lg:justify-between">
            <div className="flex min-w-0 items-start gap-4">
              <div className="min-w-0">
                {activeView === "scribe" ? (
                  <img
                    alt="ClinicScribe"
                    className="h-16 max-w-full object-contain sm:h-20"
                    src={BRAND_LOGO_SRC}
                  />
                ) : (
                  <h1 className="text-2xl font-semibold tracking-normal text-zinc-950">
                    {pageTitle}
                  </h1>
                )}
                <p
                  className={`${
                    activeView === "scribe" ? "mt-3" : "mt-2"
                  } text-sm text-zinc-500`}
                >
                  {pageDescription}
                </p>
              </div>
            </div>

            <div className="shrink-0 rounded-2xl border border-zinc-200 bg-zinc-50 px-4 py-3 text-sm">
              <p className="font-medium text-zinc-700">Signed in</p>
              <p className="mt-1 text-zinc-950">{currentUser.name}</p>
              <p className="mt-1 text-xs text-zinc-500">{currentUser.email}</p>
              <button
                className="mt-3 rounded-lg border border-zinc-300 px-3 py-2 text-xs font-semibold text-zinc-700 transition hover:border-zinc-400 hover:bg-white"
                disabled={isLoggingOut}
                onClick={() => void handleLogout()}
                type="button"
              >
                {isLoggingOut ? "Signing out..." : "Sign out"}
              </button>
            </div>
          </div>

          <div className="mb-6 flex flex-wrap gap-2">
            {activeView !== "scribe" ? (
              <button
                className="rounded-lg border border-zinc-300 px-4 py-2 text-sm font-semibold text-zinc-700 transition hover:border-zinc-400 hover:bg-zinc-50"
                onClick={() => navigateToView("scribe")}
                type="button"
              >
                Return home
              </button>
            ) : null}

            {activeView !== "dashboard" ? (
              <button
                className="rounded-lg border border-zinc-300 px-4 py-2 text-sm font-semibold text-zinc-700 transition hover:border-zinc-400 hover:bg-zinc-50"
                onClick={() => navigateToView("dashboard")}
                type="button"
              >
                Open dashboard
              </button>
            ) : null}

            {activeView === "dashboard" ? (
              <button
                className="rounded-lg border border-zinc-300 px-4 py-2 text-sm font-semibold text-zinc-700 transition hover:border-zinc-400 hover:bg-zinc-50"
                disabled={isLoadingNotes}
                onClick={() => void loadSavedNotes()}
                type="button"
              >
                {isLoadingNotes ? "Refreshing..." : "Refresh"}
              </button>
            ) : null}
          </div>

          {activeView === "dashboard" ? (
            <div className="rounded-2xl border border-zinc-200 p-5">
              {vaultError ? (
                <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
                  {vaultError}
                </div>
              ) : null}

              <div className="mt-5 space-y-3">
                {savedNotes.length === 0 && !isLoadingNotes ? (
                  <p className="rounded-xl bg-zinc-50 px-4 py-3 text-sm text-zinc-500">
                    No saved notes yet.
                  </p>
                ) : null}

                {savedNotes.map((savedNote) => (
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
                          {savedNote.pinned ? "Pinned - " : ""}
                          {savedNote.title}
                        </p>
                        <p className="mt-1 text-sm text-zinc-500">
                          {formatDate(savedNote.createdAt)}
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
                      </button>

                      <div className="flex flex-wrap gap-2">
                        <button
                          className="rounded-lg border border-zinc-300 px-3 py-2 text-xs font-semibold text-zinc-700 transition hover:border-zinc-400 hover:bg-white"
                          onClick={() => togglePinnedNote(savedNote)}
                          type="button"
                        >
                          {savedNote.pinned ? "Unpin" : "Pin"}
                        </button>
                        <button
                          className="rounded-lg border border-zinc-300 px-3 py-2 text-xs font-semibold text-zinc-700 transition hover:border-zinc-400 hover:bg-white"
                          onClick={() => renameSavedNote(savedNote)}
                          type="button"
                        >
                          Rename
                        </button>
                        <button
                          className="rounded-lg border border-red-200 px-3 py-2 text-xs font-semibold text-red-700 transition hover:border-red-300 hover:bg-red-50"
                          onClick={() => void deleteSavedNote(savedNote)}
                          type="button"
                        >
                          Delete
                        </button>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ) : activeView === "scribe" ? (
            <>

          <textarea
            className="min-h-72 w-full resize-none rounded-2xl border border-zinc-200 bg-zinc-50 p-4 text-base leading-7 text-zinc-900 shadow-inner outline-none transition focus:border-zinc-400 focus:bg-white focus:ring-4 focus:ring-zinc-100"
            onChange={(event) => {
              setTranscript(event.target.value);
              setNoteResult(null);
              setBaseNoteResult(null);
              setCurrentNoteTranscript("");
              setCurrentNoteTitle("");
              setActiveNoteLanguage("Original");
              setSelectedTranslationLanguage("");
              setTranslationStatus("");
            }}
            placeholder="Vietnamese or English clinic transcript will appear here..."
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

            <div className="flex flex-col gap-2 sm:flex-row">
              <button
                className="rounded-lg border border-zinc-300 px-5 py-3 text-sm font-semibold text-zinc-700 transition hover:border-zinc-400 hover:bg-zinc-50 disabled:cursor-not-allowed disabled:border-zinc-200 disabled:text-zinc-400"
                disabled={
                  !hasCurrentDraft ||
                  isRecording ||
                  isUploading ||
                  isGeneratingNote
                }
                onClick={clearCurrentTranscript}
                type="button"
              >
                Clear transcript
              </button>

              <button
                className="rounded-lg border border-zinc-300 px-5 py-3 text-sm font-semibold text-zinc-700 transition hover:border-zinc-400 hover:bg-zinc-50 disabled:cursor-not-allowed disabled:border-zinc-200 disabled:text-zinc-400"
                disabled={isUploading}
                onClick={handleButtonClick}
                type="button"
              >
                {isRecording ? "Stop recording" : "Start recording"}
              </button>

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
              <p className="mt-1 text-sm text-zinc-500">
                {noteHeading || "Review the generated documentation."}
              </p>
            </div>

            <button
              className="rounded-lg border border-zinc-300 px-4 py-2 text-sm font-semibold text-zinc-700 transition hover:border-zinc-400 hover:bg-zinc-50"
              onClick={() => navigateToView("scribe")}
              type="button"
            >
              Return home
            </button>
          </div>

          {noteError ? (
            <div className="mt-5 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
              {noteError}
            </div>
          ) : null}

          {noteResult ? (
            <div className="mt-6 space-y-6">
              <section className="rounded-2xl border border-zinc-200 p-5">
                <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
                  <div>
                    <p className="text-sm font-semibold text-zinc-500">
                      {activeNoteLabel}
                    </p>
                    <h3 className="mt-1 text-lg font-semibold text-zinc-950">
                      {noteHeading || "Saved ClinicScribe note"}
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

              {currentNoteTranscript.trim() ? (
                <section className="rounded-2xl border border-zinc-200 p-5">
                  <h3 className="text-lg font-semibold text-zinc-950">
                    Saved transcript
                  </h3>
                  <p className="mt-3 whitespace-pre-wrap rounded-xl bg-zinc-50 p-4 text-sm leading-6 text-zinc-700">
                    {currentNoteTranscript}
                  </p>
                </section>
              ) : null}

              {currentNoteRecordings.length > 0 ? (
                <section className="rounded-2xl border border-zinc-200 p-5">
                  <h3 className="text-lg font-semibold text-zinc-950">
                    Recorded audio
                  </h3>
                  <div className="mt-4 space-y-3">
                    {currentNoteRecordings.map((recording, index) => (
                      <div
                        className="rounded-xl border border-zinc-200 bg-zinc-50 p-3"
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
                </section>
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
    </main>
  );
}

export default App;
