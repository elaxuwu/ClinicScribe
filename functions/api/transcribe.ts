import { requireAuthenticatedUser, type AuthEnv } from "./auth";
import { savePendingRecording } from "../../src/server/note-store";

interface Env extends AuthEnv {
  PROXY_BASE_URL?: string;
  TRANSCRIPTION_MODEL?: string;
  PROXY_SHARED_SECRET?: string;
}

const TRANSCRIPTION_MODEL_ENV = "TRANSCRIPTION_MODEL";
const DIARIZED_TRANSCRIPTION_MODEL = "gpt-4o-transcribe-diarize";
const TRANSCRIPTIONS_PATH = "/v1/audio/transcriptions";
const MAX_AUDIO_UPLOAD_BYTES = 25 * 1024 * 1024;
const MAX_MULTIPART_UPLOAD_BYTES = MAX_AUDIO_UPLOAD_BYTES + 1024 * 1024;
const ALLOWED_AUDIO_TYPES = new Set([
  "audio/mp4",
  "audio/mpeg",
  "audio/ogg",
  "audio/wav",
  "audio/webm",
  "audio/x-wav",
]);

const jsonHeaders = {
  "Content-Type": "application/json",
};

const jsonResponse = (body: unknown, init?: ResponseInit) =>
  new Response(JSON.stringify(body), {
    ...init,
    headers: {
      ...jsonHeaders,
      ...init?.headers,
    },
  });

const getNormalizedMediaType = (type: string) =>
  type.split(";")[0]?.trim().toLowerCase() ?? "";

export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  const authResult = await requireAuthenticatedUser(request, env);

  if (authResult instanceof Response) {
    return authResult;
  }

  const proxyBaseUrl = env.PROXY_BASE_URL?.trim().replace(/\/+$/, "");
  const transcriptionModel = env.TRANSCRIPTION_MODEL?.trim();

  if (!proxyBaseUrl) {
    return jsonResponse(
      { error: "Missing PROXY_BASE_URL environment variable." },
      { status: 500 },
    );
  }

  if (!transcriptionModel) {
    return jsonResponse(
      { error: `Missing ${TRANSCRIPTION_MODEL_ENV} environment variable.` },
      { status: 500 },
    );
  }

  const contentType = request.headers.get("content-type") ?? "";

  if (!contentType.includes("multipart/form-data")) {
    return jsonResponse(
      { error: "Request must be multipart/form-data with an audio file." },
      { status: 400 },
    );
  }

  const contentLengthHeader = request.headers.get("content-length");
  const contentLength = contentLengthHeader
    ? Number.parseInt(contentLengthHeader, 10)
    : Number.NaN;

  if (
    Number.isFinite(contentLength) &&
    contentLength > MAX_MULTIPART_UPLOAD_BYTES
  ) {
    return jsonResponse(
      { error: "Audio upload is too large." },
      { status: 413 },
    );
  }

  let requestFormData: FormData;

  try {
    requestFormData = await request.formData();
  } catch {
    return jsonResponse(
      { error: "Unable to read multipart form data." },
      { status: 400 },
    );
  }

  const audio = requestFormData.get("audio");

  if (!(audio instanceof File) || audio.size === 0) {
    return jsonResponse(
      { error: "A non-empty audio file field named 'audio' is required." },
      { status: 400 },
    );
  }

  if (audio.size > MAX_AUDIO_UPLOAD_BYTES) {
    return jsonResponse(
      { error: "Audio file must be 25 MB or smaller." },
      { status: 413 },
    );
  }

  if (!ALLOWED_AUDIO_TYPES.has(getNormalizedMediaType(audio.type))) {
    return jsonResponse(
      { error: "Audio file type is not supported." },
      { status: 415 },
    );
  }

  const proxyFormData = new FormData();
  proxyFormData.set(
    "file",
    audio,
    audio.name || `clinic-recording.${audio.type.includes("mp4") ? "mp4" : "webm"}`,
  );
  proxyFormData.set("model", transcriptionModel);

  if (transcriptionModel === DIARIZED_TRANSCRIPTION_MODEL) {
    proxyFormData.set("response_format", "diarized_json");
  }

  try {
    const headers = new Headers();

    if (env.PROXY_SHARED_SECRET) {
      headers.set("X-Internal-Proxy-Key", env.PROXY_SHARED_SECRET);
    }

    const upstreamResponse = await fetch(`${proxyBaseUrl}${TRANSCRIPTIONS_PATH}`, {
      method: "POST",
      headers,
      body: proxyFormData,
    });

    const upstreamText = await upstreamResponse.text();
    let upstreamJson: unknown;

    try {
      upstreamJson = JSON.parse(upstreamText);
    } catch {
      return jsonResponse(
        {
          error: "Transcription proxy returned an invalid response.",
        },
        { status: 502 },
      );
    }

    if (!upstreamResponse.ok) {
      return jsonResponse(
        {
          error: "Transcription proxy request failed.",
          status: upstreamResponse.status,
        },
        { status: upstreamResponse.status },
      );
    }

    let recording: Awaited<ReturnType<typeof savePendingRecording>>;

    try {
      recording = await savePendingRecording(env, authResult.id, audio);
    } catch (error) {
      return jsonResponse(
        {
          error: "Unable to save recorded audio.",
        },
        { status: 500 },
      );
    }

    if (upstreamJson && typeof upstreamJson === "object" && !Array.isArray(upstreamJson)) {
      return jsonResponse({
        ...(upstreamJson as Record<string, unknown>),
        recording,
      });
    }

    return jsonResponse({ result: upstreamJson, recording });
  } catch (error) {
    return jsonResponse(
      {
        error: "Unable to reach transcription proxy.",
      },
      { status: 502 },
    );
  }
};
