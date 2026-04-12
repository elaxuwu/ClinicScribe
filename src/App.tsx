import { useCallback, useEffect, useRef, useState } from "react";
import {
  REALTIME_MODEL,
  TRANSCRIPTION_INSTRUCTIONS,
} from "./config/realtime";

type SessionResponse = {
  client_secret?: {
    value?: string;
  };
};

type RealtimeEvent = {
  type?: string;
  delta?: string;
  text?: string;
  transcript?: string;
  error?: {
    message?: string;
  };
  [key: string]: unknown;
};

type NoteResult = {
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

const REALTIME_URL = "https://api.featherless.ai/v1/realtime";

const getErrorMessage = (value: unknown, fallback: string) => {
  if (value && typeof value === "object" && "error" in value) {
    const error = (value as { error?: unknown }).error;
    if (typeof error === "string") {
      return error;
    }
  }

  return fallback;
};

const renderList = (items: string[]) => {
  if (items.length === 0) {
    return <p className="text-sm text-zinc-500">None documented.</p>;
  }

  return (
    <ul className="space-y-2 text-sm leading-6 text-zinc-700">
      {items.map((item, index) => (
        <li key={`${item}-${index}`} className="rounded-lg bg-zinc-50 px-3 py-2">
          {item}
        </li>
      ))}
    </ul>
  );
};

function App() {
  const [transcript, setTranscript] = useState("");
  const [status, setStatus] = useState("Ready");
  const [isConnecting, setIsConnecting] = useState(false);
  const [isRecording, setIsRecording] = useState(false);
  const [isProcessing, setIsProcessing] = useState(false);
  const [isGeneratingNote, setIsGeneratingNote] = useState(false);
  const [noteError, setNoteError] = useState("");
  const [noteResult, setNoteResult] = useState<NoteResult | null>(null);

  const peerConnectionRef = useRef<RTCPeerConnection | null>(null);
  const dataChannelRef = useRef<RTCDataChannel | null>(null);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const streamedTextRef = useRef("");

  const cleanupConnection = useCallback(() => {
    mediaStreamRef.current?.getTracks().forEach((track) => track.stop());
    mediaStreamRef.current = null;

    if (dataChannelRef.current) {
      dataChannelRef.current.close();
      dataChannelRef.current = null;
    }

    if (peerConnectionRef.current) {
      peerConnectionRef.current.close();
      peerConnectionRef.current = null;
    }
  }, []);

  const sendRealtimeEvent = useCallback((event: Record<string, unknown>) => {
    const dataChannel = dataChannelRef.current;

    if (!dataChannel || dataChannel.readyState !== "open") {
      console.warn("Realtime data channel is not open.", event);
      return false;
    }

    dataChannel.send(JSON.stringify(event));
    return true;
  }, []);

  const handleRealtimeEvent = useCallback(
    (event: RealtimeEvent) => {
      console.log("Featherless realtime event:", event);

      if (event.type === "error") {
        setStatus(event.error?.message ?? "Realtime session error");
        setIsProcessing(false);
        setIsRecording(false);
        cleanupConnection();
        return;
      }

      if (
        event.type === "conversation.item.input_audio_transcription.completed" &&
        typeof event.transcript === "string"
      ) {
        streamedTextRef.current = event.transcript;
        setTranscript(event.transcript);
        return;
      }

      if (event.type === "response.text.delta" && typeof event.delta === "string") {
        streamedTextRef.current += event.delta;
        setTranscript(streamedTextRef.current);
        return;
      }

      if (event.type === "response.text.done" && typeof event.text === "string") {
        streamedTextRef.current = event.text;
        setTranscript(event.text);
        return;
      }

      if (event.type === "response.done") {
        setStatus("Transcript ready");
        setIsProcessing(false);
        cleanupConnection();
      }
    },
    [cleanupConnection],
  );

  const startRecording = async () => {
    setIsConnecting(true);
    setStatus("Creating realtime session");
    setTranscript("");
    streamedTextRef.current = "";
    cleanupConnection();

    try {
      const sessionResponse = await fetch("/api/session", {
        method: "POST",
      });

      if (!sessionResponse.ok) {
        const errorText = await sessionResponse.text();
        throw new Error(errorText || "Unable to create realtime session.");
      }

      const session = (await sessionResponse.json()) as SessionResponse;
      const ephemeralKey = session.client_secret?.value;

      if (!ephemeralKey) {
        throw new Error("Realtime session response did not include an ephemeral key.");
      }

      const peerConnection = new RTCPeerConnection();
      peerConnectionRef.current = peerConnection;

      const dataChannel = peerConnection.createDataChannel("oai-events");
      dataChannelRef.current = dataChannel;

      dataChannel.addEventListener("open", () => {
        setStatus("Recording");
        sendRealtimeEvent({
          type: "session.update",
          session: {
            instructions: TRANSCRIPTION_INSTRUCTIONS,
            modalities: ["text"],
            turn_detection: null,
          },
        });
      });

      dataChannel.addEventListener("message", (message) => {
        try {
          handleRealtimeEvent(JSON.parse(message.data) as RealtimeEvent);
        } catch (error) {
          console.error("Unable to parse realtime event:", error, message.data);
        }
      });

      dataChannel.addEventListener("close", () => {
        setIsRecording(false);
      });

      const mediaStream = await navigator.mediaDevices.getUserMedia({
        audio: true,
      });
      mediaStreamRef.current = mediaStream;
      mediaStream.getAudioTracks().forEach((track) => {
        peerConnection.addTrack(track, mediaStream);
      });

      const offer = await peerConnection.createOffer();
      await peerConnection.setLocalDescription(offer);

      if (!offer.sdp) {
        throw new Error("Unable to create a valid WebRTC offer.");
      }

      const sdpResponse = await fetch(
        `${REALTIME_URL}?model=${encodeURIComponent(REALTIME_MODEL)}`,
        {
          method: "POST",
          body: offer.sdp,
          headers: {
            Authorization: `Bearer ${ephemeralKey}`,
            "Content-Type": "application/sdp",
          },
        },
      );

      const answerSdp = await sdpResponse.text();

      if (!sdpResponse.ok) {
        throw new Error(answerSdp || "Featherless SDP exchange failed.");
      }

      await peerConnection.setRemoteDescription({
        type: "answer",
        sdp: answerSdp,
      });

      setIsRecording(true);
      setStatus("Recording");
    } catch (error) {
      console.error(error);
      setStatus(error instanceof Error ? error.message : "Recording failed");
      cleanupConnection();
    } finally {
      setIsConnecting(false);
    }
  };

  const stopRecording = () => {
    setIsRecording(false);
    setIsProcessing(true);
    setStatus("Finalizing transcript");

    mediaStreamRef.current?.getTracks().forEach((track) => track.stop());
    mediaStreamRef.current = null;

    const committed = sendRealtimeEvent({
      type: "input_audio_buffer.commit",
    });

    if (!committed) {
      setStatus("Unable to finalize because the realtime channel closed");
      setIsProcessing(false);
      cleanupConnection();
      return;
    }

    sendRealtimeEvent({
      type: "response.create",
      response: {
        modalities: ["text"],
        instructions: TRANSCRIPTION_INSTRUCTIONS,
      },
    });
  };

  const handleButtonClick = () => {
    if (isRecording) {
      stopRecording();
      return;
    }

    void startRecording();
  };

  const generateNote = async () => {
    setIsGeneratingNote(true);
    setNoteError("");
    setNoteResult(null);

    try {
      const response = await fetch("/api/make-note", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
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
    } catch (error) {
      setNoteError(
        error instanceof Error
          ? error.message
          : "Something went wrong while generating the note.",
      );
    } finally {
      setIsGeneratingNote(false);
    }
  };

  useEffect(() => {
    return cleanupConnection;
  }, [cleanupConnection]);

  return (
    <main className="min-h-screen bg-zinc-100 px-4 py-8 text-zinc-950 sm:px-6 lg:px-8">
      <section className="mx-auto flex max-w-5xl flex-col gap-6">
        <div className="rounded-[2rem] border border-zinc-200 bg-white p-6 shadow-sm sm:p-8">
          <div className="mb-6">
            <p className="text-sm font-medium text-zinc-500">ClinicScribe</p>
            <h1 className="mt-2 text-2xl font-semibold tracking-normal text-zinc-950">
              Realtime transcription and note maker
            </h1>
          </div>

          <textarea
            className="min-h-72 w-full resize-none rounded-2xl border border-zinc-200 bg-zinc-50 p-4 text-base leading-7 text-zinc-900 shadow-inner outline-none transition focus:border-zinc-400 focus:bg-white focus:ring-4 focus:ring-zinc-100"
            onChange={(event) => setTranscript(event.target.value)}
            placeholder="Vietnamese or English clinic transcript will appear here, or paste one for testing..."
            value={transcript}
          />

          <div className="mt-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <p className="text-sm text-zinc-500">
              {isRecording ? "Recording in progress" : status}
              {isProcessing ? "..." : ""}
            </p>

            <button
              className="rounded-lg bg-zinc-950 px-5 py-3 text-sm font-semibold text-white shadow-sm transition hover:bg-zinc-800 disabled:cursor-not-allowed disabled:bg-zinc-400"
              disabled={isConnecting || isProcessing}
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
                Generate structured documentation from the transcript above.
              </p>
            </div>

            <button
              className="rounded-lg bg-zinc-950 px-5 py-3 text-sm font-semibold text-white shadow-sm transition hover:bg-zinc-800 disabled:cursor-not-allowed disabled:bg-zinc-400"
              disabled={
                isGeneratingNote ||
                isRecording ||
                isProcessing ||
                transcript.trim().length === 0
              }
              onClick={() => void generateNote()}
              type="button"
            >
              {isGeneratingNote ? "Generating..." : "Generate note"}
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
                  <p className="text-sm text-zinc-500">
                    Language: {noteResult.language_detected || "Unknown"}
                  </p>
                </div>
                <div className="grid gap-4 md:grid-cols-2">
                  <div>
                    <p className="text-sm font-semibold text-zinc-900">Subjective</p>
                    <p className="mt-1 whitespace-pre-wrap text-sm leading-6 text-zinc-700">
                      {noteResult.soap.subjective || "Not documented."}
                    </p>
                  </div>
                  <div>
                    <p className="text-sm font-semibold text-zinc-900">Objective</p>
                    <p className="mt-1 whitespace-pre-wrap text-sm leading-6 text-zinc-700">
                      {noteResult.soap.objective || "Not documented."}
                    </p>
                  </div>
                  <div>
                    <p className="text-sm font-semibold text-zinc-900">Assessment</p>
                    <p className="mt-1 whitespace-pre-wrap text-sm leading-6 text-zinc-700">
                      {noteResult.soap.assessment || "Not documented."}
                    </p>
                  </div>
                  <div>
                    <p className="text-sm font-semibold text-zinc-900">Plan</p>
                    <p className="mt-1 whitespace-pre-wrap text-sm leading-6 text-zinc-700">
                      {noteResult.soap.plan || "Not documented."}
                    </p>
                  </div>
                </div>
              </section>

              <section className="rounded-2xl border border-zinc-200 p-5">
                <h3 className="text-lg font-semibold text-zinc-950">Visit Summary</h3>
                <p className="mt-2 whitespace-pre-wrap text-sm leading-6 text-zinc-700">
                  {noteResult.visit_summary || "Not documented."}
                </p>
              </section>

              <section className="rounded-2xl border border-zinc-200 p-5">
                <h3 className="text-lg font-semibold text-zinc-950">Extracted Data</h3>
                <div className="mt-4 grid gap-4 md:grid-cols-2">
                  <div>
                    <p className="mb-2 text-sm font-semibold text-zinc-900">Symptoms</p>
                    {renderList(noteResult.extracted.symptoms)}
                  </div>
                  <div>
                    <p className="mb-2 text-sm font-semibold text-zinc-900">Medications</p>
                    {renderList(noteResult.extracted.medications)}
                  </div>
                  <div>
                    <p className="mb-2 text-sm font-semibold text-zinc-900">
                      Follow-up Plan
                    </p>
                    {renderList(noteResult.extracted.follow_up_plan)}
                  </div>
                  <div>
                    <p className="mb-2 text-sm font-semibold text-zinc-900">Red Flags</p>
                    {renderList(noteResult.extracted.red_flags)}
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
                  {noteResult.discharge_instructions || "Not documented."}
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
