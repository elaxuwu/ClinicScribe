interface Env {
  PROXY_BASE_URL?: string;
  TRANSCRIPTION_MODEL?: string;
  PROXY_SHARED_SECRET?: string;
}

const TRANSCRIPTION_MODEL_ENV = "TRANSCRIPTION_MODEL";
const DIARIZED_TRANSCRIPTION_MODEL = "gpt-4o-transcribe-diarize";
const TRANSCRIPTIONS_PATH = "/v1/audio/transcriptions";

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

export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
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
          error: "Transcription proxy returned a non-JSON response.",
          details: upstreamText.slice(0, 500),
        },
        { status: 502 },
      );
    }

    if (!upstreamResponse.ok) {
      return jsonResponse(
        {
          error: "Transcription proxy request failed.",
          status: upstreamResponse.status,
          details: upstreamJson,
        },
        { status: upstreamResponse.status },
      );
    }

    return jsonResponse(upstreamJson);
  } catch (error) {
    return jsonResponse(
      {
        error: "Unable to reach transcription proxy.",
        details: error instanceof Error ? error.message : "Unknown error",
      },
      { status: 502 },
    );
  }
};
