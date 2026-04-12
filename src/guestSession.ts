export type GuestSession = {
  id: string;
  displayName: string;
  createdAt: string;
};

export const GUEST_SESSION_STORAGE_KEY = "clinicscribe.guest-session";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

const isGuestSession = (value: unknown): value is GuestSession => {
  if (!isRecord(value)) {
    return false;
  }

  return (
    typeof value.id === "string" &&
    value.id.trim().length > 0 &&
    typeof value.displayName === "string" &&
    value.displayName.trim().length > 0 &&
    typeof value.createdAt === "string" &&
    value.createdAt.trim().length > 0 &&
    !Number.isNaN(Date.parse(value.createdAt))
  );
};

const getStorage = () => {
  if (typeof window === "undefined") {
    return null;
  }

  try {
    return window.localStorage;
  } catch {
    return null;
  }
};

const removeStoredGuestSession = (storage: Storage | null) => {
  if (!storage) {
    return;
  }

  try {
    storage.removeItem(GUEST_SESSION_STORAGE_KEY);
  } catch {
    // Ignore storage cleanup failures so the app can keep working in memory.
  }
};

export const persistGuestSession = (session: GuestSession) => {
  const storage = getStorage();

  if (!storage) {
    return;
  }

  try {
    storage.setItem(GUEST_SESSION_STORAGE_KEY, JSON.stringify(session));
  } catch {
    // Ignore persistence failures so the app can keep working in memory.
  }
};

const getRandomToken = () => {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID().replace(/-/g, "");
  }

  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`;
};

export const createGuestSession = (): GuestSession => {
  const token = getRandomToken();
  const guestLabelSuffix = token.slice(0, 4).toUpperCase();

  return {
    id: `guest_${token}`,
    displayName: `Guest-${guestLabelSuffix}`,
    createdAt: new Date().toISOString(),
  };
};

export const readGuestSession = (): GuestSession | null => {
  const storage = getStorage();

  if (!storage) {
    return null;
  }

  let rawValue: string | null = null;

  try {
    rawValue = storage.getItem(GUEST_SESSION_STORAGE_KEY);
  } catch {
    return null;
  }

  if (!rawValue) {
    return null;
  }

  try {
    const parsed = JSON.parse(rawValue) as unknown;

    if (isGuestSession(parsed)) {
      return parsed;
    }
  } catch {
    // Fall through to remove corrupt storage below.
  }

  removeStoredGuestSession(storage);
  return null;
};
