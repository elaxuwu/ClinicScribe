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
  [key: string]: unknown;
};

type NoteResult = {
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
  const [noteError, setNoteError] = useState("");
  const [isGeneratingNote, setIsGeneratingNote] = useState(false);

  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<BlobPart[]>([]);

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
      setNoteError("");
      setStatus("Ready");
    } catch (logoutError) {
      setError(
        logoutError instanceof Error ? logoutError.message : "Unable to sign out.",
      );
    } finally {
      setIsLoggingOut(false);
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

      if (!formattedTranscript) {
        throw new Error("No transcript text was returned.");
      }

      setError("");
      setTranscript(formattedTranscript);
      setNoteResult(null);
      setStatus("Transcript ready");
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
    setTranscript("");
    setNoteError("");
    setNoteResult(null);

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

  const generateNote = async () => {
    if (!transcript.trim()) {
      setNoteError("Add or record a transcript before generating a note.");
      return;
    }

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
        body: JSON.stringify({ transcript }),
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

      setNoteResult(responseJson as NoteResult);
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
            <p className="text-sm font-medium text-zinc-500">ClinicScribe</p>
            <h1 className="mt-2 text-2xl font-semibold tracking-normal text-zinc-950">
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

  return (
    <main className="min-h-screen bg-zinc-100 px-4 py-8 text-zinc-950 sm:px-6 lg:px-8">
      <section className="mx-auto flex max-w-5xl flex-col gap-6">
        <div className="rounded-[2rem] border border-zinc-200 bg-white p-6 shadow-sm sm:p-8">
          <div className="mb-6 flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
            <div>
              <p className="text-sm font-medium text-zinc-500">ClinicScribe</p>
              <h1 className="mt-2 text-2xl font-semibold tracking-normal text-zinc-950">
                Speech-to-text prototype
              </h1>
            </div>

            <div className="rounded-2xl border border-zinc-200 bg-zinc-50 px-4 py-3 text-sm">
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

          <textarea
            className="min-h-72 w-full resize-none rounded-2xl border border-zinc-200 bg-zinc-50 p-4 text-base leading-7 text-zinc-900 shadow-inner outline-none transition focus:border-zinc-400 focus:bg-white focus:ring-4 focus:ring-zinc-100"
            onChange={(event) => {
              setTranscript(event.target.value);
              setNoteResult(null);
            }}
            placeholder="Vietnamese or English clinic transcript will appear here..."
            value={transcript}
          />

          {error ? (
            <div className="mt-4 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
              {error}
            </div>
          ) : null}

          <div className="mt-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <p className="text-sm text-zinc-500">
              {isRecording ? "Recording in progress" : status}
              {isUploading ? "..." : ""}
            </p>

            <button
              className="rounded-lg bg-zinc-950 px-5 py-3 text-sm font-semibold text-white shadow-sm transition hover:bg-zinc-800 disabled:cursor-not-allowed disabled:bg-zinc-400"
              disabled={isUploading}
              onClick={handleButtonClick}
              type="button"
            >
              {isRecording ? "Stop recording" : "Start recording"}
            </button>
          </div>
        </div>

        <div className="rounded-[2rem] border border-zinc-200 bg-white p-6 shadow-sm sm:p-8">
          <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <h2 className="text-xl font-semibold tracking-normal text-zinc-950">
                Note maker
              </h2>
              <p className="mt-1 text-sm text-zinc-500">
                Generate SOAP documentation from the transcript above.
              </p>
            </div>

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

          {noteError ? (
            <div className="mt-5 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
              {noteError}
            </div>
          ) : null}

          {noteResult ? (
            <div className="mt-6 space-y-6">
              <section className="rounded-2xl border border-zinc-200 p-5">
                <div className="mb-4 flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between">
                  <h3 className="text-lg font-semibold text-zinc-950">SOAP</h3>
                  <div className="text-sm text-zinc-500 sm:text-right">
                    <p>Language: {asText(noteResult.language_detected)}</p>
                    {getProviderLabel(noteResult.provider_used) ? (
                      <p>Provider: {getProviderLabel(noteResult.provider_used)}</p>
                    ) : null}
                  </div>
                </div>

                <div className="grid gap-4 md:grid-cols-2">
                  <div>
                    <p className="text-sm font-semibold text-zinc-900">Subjective</p>
                    <p className="mt-1 whitespace-pre-wrap text-sm leading-6 text-zinc-700">
                      {asText(noteResult.soap?.subjective)}
                    </p>
                  </div>
                  <div>
                    <p className="text-sm font-semibold text-zinc-900">Objective</p>
                    <p className="mt-1 whitespace-pre-wrap text-sm leading-6 text-zinc-700">
                      {asText(noteResult.soap?.objective)}
                    </p>
                  </div>
                  <div>
                    <p className="text-sm font-semibold text-zinc-900">Assessment</p>
                    <p className="mt-1 whitespace-pre-wrap text-sm leading-6 text-zinc-700">
                      {asText(noteResult.soap?.assessment)}
                    </p>
                  </div>
                  <div>
                    <p className="text-sm font-semibold text-zinc-900">Plan</p>
                    <p className="mt-1 whitespace-pre-wrap text-sm leading-6 text-zinc-700">
                      {asText(noteResult.soap?.plan)}
                    </p>
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
          ) : null}
        </div>
      </section>
    </main>
  );
}

export default App;
