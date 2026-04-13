import { requireAuthenticatedUser, type AuthEnv } from "./auth";
import {
  getClinicNote,
  listClinicNotes,
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

export const onRequestGet: PagesFunction<AuthEnv> = async ({ request, env }) => {
  const authResult = await requireAuthenticatedUser(request, env);

  if (authResult instanceof Response) {
    return authResult;
  }

  const url = new URL(request.url);
  const noteId = url.searchParams.get("id")?.trim();

  if (noteId) {
    const note = await getClinicNote(env, authResult.id, noteId);

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
        result: toNoteResponse(note),
        translations: note.translations,
      },
    });
  }

  const notes = await listClinicNotes(env, authResult.id);

  return jsonResponse({
    notes: notes.map(summarizeClinicNote),
  });
};
