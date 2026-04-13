import { requireAuthenticatedUser, type AuthEnv } from "./auth";
import {
  deleteClinicNote,
  getClinicNote,
  listClinicNotes,
  saveClinicNoteRecord,
  summarizeClinicNote,
  toNoteResponse,
} from "../../src/server/note-store";

const jsonHeaders = {
  "Content-Type": "application/json",
  "Cache-Control": "no-store",
};

const jsonResponse = (body: unknown, init?: ResponseInit) =>
  new Response(JSON.stringify(body), {
    ...init,
    headers: {
      ...jsonHeaders,
      ...init?.headers,
    },
  });

const getErrorMessage = (error: unknown) =>
  error instanceof Error ? error.message : "Unknown error";

export const onRequestGet: PagesFunction<AuthEnv> = async ({ request, env }) => {
  const authResult = await requireAuthenticatedUser(request, env);

  if (authResult instanceof Response) {
    return authResult;
  }

  const url = new URL(request.url);
  const noteId = url.searchParams.get("id")?.trim();

  if (noteId) {
    let note: Awaited<ReturnType<typeof getClinicNote>>;

    try {
      note = await getClinicNote(env, authResult.id, noteId);
    } catch (error) {
      return jsonResponse(
        {
          error: "Unable to load saved note.",
          details: getErrorMessage(error),
        },
        { status: 500 },
      );
    }

    if (!note) {
      return jsonResponse({ error: "Saved note not found." }, { status: 404 });
    }

    return jsonResponse({
      note: {
        id: note.id,
        title: note.title,
        transcript: note.transcript,
        createdAt: note.createdAt,
        updatedAt: note.updatedAt,
        pinned: note.pinned,
        pinnedAt: note.pinnedAt,
        result: toNoteResponse(note),
        recordings: note.recordings,
        translations: note.translations,
      },
    });
  }

  let notes: Awaited<ReturnType<typeof listClinicNotes>>;

  try {
    notes = await listClinicNotes(env, authResult.id);
  } catch (error) {
    return jsonResponse(
      {
        error: "Unable to load note vault.",
        details: getErrorMessage(error),
      },
      { status: 500 },
    );
  }

  return jsonResponse({
    notes: notes.map(summarizeClinicNote),
  });
};

export const onRequestPatch: PagesFunction<AuthEnv> = async ({ request, env }) => {
  const authResult = await requireAuthenticatedUser(request, env);

  if (authResult instanceof Response) {
    return authResult;
  }

  let body: unknown;

  try {
    body = await request.json();
  } catch {
    return jsonResponse({ error: "Request body must be valid JSON." }, { status: 400 });
  }

  const record =
    body && typeof body === "object" ? (body as Record<string, unknown>) : {};
  const noteId = typeof record.id === "string" ? record.id.trim() : "";

  if (!noteId) {
    return jsonResponse({ error: "id is required." }, { status: 400 });
  }

  let note: Awaited<ReturnType<typeof getClinicNote>>;

  try {
    note = await getClinicNote(env, authResult.id, noteId);
  } catch (error) {
    return jsonResponse(
      {
        error: "Unable to load saved note.",
        details: getErrorMessage(error),
      },
      { status: 500 },
    );
  }

  if (!note) {
    return jsonResponse({ error: "Saved note not found." }, { status: 404 });
  }

  const title =
    typeof record.title === "string" ? record.title.replace(/\s+/g, " ").trim() : null;

  if (title !== null && (!title || title.length > 120)) {
    return jsonResponse(
      { error: "title must be between 1 and 120 characters." },
      { status: 400 },
    );
  }

  const nextPinned =
    typeof record.pinned === "boolean" ? record.pinned : note.pinned;
  const now = new Date().toISOString();

  try {
    const savedNote = await saveClinicNoteRecord(env, {
      ...note,
      title: title ?? note.title,
      pinned: nextPinned,
      pinnedAt: nextPinned ? note.pinnedAt ?? now : undefined,
    });

    return jsonResponse({
      note: {
        id: savedNote.id,
        title: savedNote.title,
        createdAt: savedNote.createdAt,
        updatedAt: savedNote.updatedAt,
        language_detected: savedNote.note.language_detected,
        provider_used: savedNote.note.provider_used,
        recording_count: savedNote.recordings.length,
        pinned: savedNote.pinned,
        pinnedAt: savedNote.pinnedAt,
        translation_languages: Object.values(savedNote.translations).map(
          (translation) => translation.language,
        ),
      },
    });
  } catch (error) {
    return jsonResponse(
      {
        error: "Unable to update saved note.",
        details: getErrorMessage(error),
      },
      { status: 500 },
    );
  }
};

export const onRequestDelete: PagesFunction<AuthEnv> = async ({ request, env }) => {
  const authResult = await requireAuthenticatedUser(request, env);

  if (authResult instanceof Response) {
    return authResult;
  }

  const url = new URL(request.url);
  const noteId = url.searchParams.get("id")?.trim();

  if (!noteId) {
    return jsonResponse({ error: "id is required." }, { status: 400 });
  }

  try {
    const deleted = await deleteClinicNote(env, authResult.id, noteId);

    if (!deleted) {
      return jsonResponse({ error: "Saved note not found." }, { status: 404 });
    }

    return jsonResponse({ ok: true, id: noteId });
  } catch (error) {
    return jsonResponse(
      {
        error: "Unable to delete saved note.",
        details: getErrorMessage(error),
      },
      { status: 500 },
    );
  }
};
