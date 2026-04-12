import { REALTIME_MODEL, REALTIME_VOICE } from "../../src/config/realtime";

interface Env {
  FEATHERLESS_API_KEY?: string;
}

const FEATHERLESS_SESSION_URL =
  "https://api.featherless.ai/v1/realtime/sessions";

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

export const onRequestPost: PagesFunction<Env> = async ({ env }) => {
  if (!env.FEATHERLESS_API_KEY) {
    return jsonResponse(
      { error: "Missing FEATHERLESS_API_KEY environment variable." },
      { status: 500 },
    );
  }

  try {
    const upstreamResponse = await fetch(FEATHERLESS_SESSION_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.FEATHERLESS_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: REALTIME_MODEL,
        voice: REALTIME_VOICE,
      }),
    });

    const responseText = await upstreamResponse.text();

    if (!upstreamResponse.ok) {
      let upstreamError: unknown = responseText;

      try {
        upstreamError = JSON.parse(responseText);
      } catch {
        // Featherless should return JSON, but keep non-JSON errors debuggable.
      }

      return jsonResponse(
        {
          error: "Failed to create Featherless realtime session.",
          status: upstreamResponse.status,
          details: upstreamError,
        },
        { status: upstreamResponse.status },
      );
    }

    return new Response(responseText, {
      status: upstreamResponse.status,
      headers: jsonHeaders,
    });
  } catch (error) {
    return jsonResponse(
      {
        error: "Unable to reach Featherless realtime session endpoint.",
        details: error instanceof Error ? error.message : "Unknown error",
      },
      { status: 502 },
    );
  }
};
