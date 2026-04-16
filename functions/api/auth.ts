export type AuthEnv = {
  UPSTASH_DATABASE_URL?: string;
  UPSTASH_DATABASE_KEY?: string;
  SUPABASE_URL?: string;
  SUPABASE_PUBLISHABLE_KEY?: string;
  VITE_SUPABASE_URL?: string;
  VITE_SUPABASE_PUBLISHABLE_KEY?: string;
};

export type PublicUser = {
  id: string;
  email: string;
  name: string;
  createdAt: string;
  accessToken?: string;
  isGuest?: boolean;
};

type StoredUser = PublicUser & {
  passwordHash: string;
  passwordSalt: string;
};

type StoredSession = {
  userId: string;
  createdAt: string;
  expiresAt: string;
};

type StoredGuestSession = StoredSession;

type UpstashResponse = {
  result?: unknown;
  error?: string;
};

type SupabaseUserResponse = {
  id?: unknown;
  email?: unknown;
  created_at?: unknown;
  user_metadata?: unknown;
};

const SESSION_COOKIE_NAME = "clinicscribe_session";
const GUEST_SESSION_COOKIE_NAME = "clinicscribe_guest_session";
const SESSION_TTL_SECONDS = 60 * 60 * 24 * 7;
const GUEST_SESSION_TTL_SECONDS = 60 * 60 * 24 * 7;
const GUEST_SESSION_CREATE_LIMIT = 30;
const GUEST_SESSION_CREATE_WINDOW_SECONDS = 60 * 60;
const GUEST_API_LIMIT = 300;
const GUEST_API_WINDOW_SECONDS = 60 * 60;
const PASSWORD_HASH_ITERATIONS = 100000;
const REDIS_PREFIX = "clinicscribe";
const textEncoder = new TextEncoder();

const jsonHeaders = {
  "Content-Type": "application/json",
  "Cache-Control": "no-store",
};

const makeJsonHeaders = (headersInit?: HeadersInit) => {
  const headers =
    headersInit instanceof Headers ? headersInit : new Headers(headersInit);

  Object.entries(jsonHeaders).forEach(([name, value]) => {
    if (!headers.has(name)) {
      headers.set(name, value);
    }
  });

  return headers;
};

const jsonResponse = (body: unknown, init?: ResponseInit) =>
  new Response(JSON.stringify(body), {
    ...init,
    headers: makeJsonHeaders(init?.headers),
  });

class AuthServiceError extends Error {
  status: number;

  constructor(message: string, status = 500) {
    super(message);
    this.name = "AuthServiceError";
    this.status = status;
  }
}

const getRedisConfig = (env: AuthEnv) => {
  const url = env.UPSTASH_DATABASE_URL?.trim().replace(/\/+$/, "");
  const key = env.UPSTASH_DATABASE_KEY?.trim();

  if (!url || !key) {
    throw new AuthServiceError(
      "Missing UPSTASH_DATABASE_URL or UPSTASH_DATABASE_KEY.",
    );
  }

  if (!url.startsWith("https://")) {
    throw new AuthServiceError(
      "UPSTASH_DATABASE_URL must be the Upstash Redis HTTPS REST URL.",
    );
  }

  return { url, key };
};

const getSupabaseConfig = (env: AuthEnv) => {
  const url = (env.SUPABASE_URL ?? env.VITE_SUPABASE_URL)
    ?.trim()
    .replace(/\/+$/, "");
  const key = (
    env.SUPABASE_PUBLISHABLE_KEY ?? env.VITE_SUPABASE_PUBLISHABLE_KEY
  )?.trim();

  if (!url || !key) {
    throw new AuthServiceError(
      "Missing SUPABASE_URL or SUPABASE_PUBLISHABLE_KEY.",
    );
  }

  if (!url.startsWith("https://")) {
    throw new AuthServiceError("SUPABASE_URL must be an HTTPS URL.");
  }

  return { url, key };
};

export const redisCommand = async (
  env: AuthEnv,
  command: Array<string | number>,
) => {
  const { url, key } = getRedisConfig(env);
  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(command),
  });

  let payload: UpstashResponse;

  try {
    payload = (await response.json()) as UpstashResponse;
  } catch {
    throw new AuthServiceError("Upstash returned an invalid response.");
  }

  if (!response.ok || payload.error) {
    throw new AuthServiceError(payload.error ?? "Upstash request failed.");
  }

  return payload.result;
};

const getUserKey = (userId: string) => `${REDIS_PREFIX}:user:${userId}`;
const getEmailKey = (email: string) => `${REDIS_PREFIX}:user-email:${email}`;
const getSessionKey = (sessionHash: string) =>
  `${REDIS_PREFIX}:session:${sessionHash}`;
const getGuestSessionKey = (sessionHash: string) =>
  `${REDIS_PREFIX}:guest-session:${sessionHash}`;
const getRateLimitKey = (scope: string, identifierHash: string) =>
  `${REDIS_PREFIX}:rate-limit:${scope}:${identifierHash}`;

const toPublicUser = (user: StoredUser): PublicUser => ({
  id: user.id,
  email: user.email,
  name: user.name,
  createdAt: user.createdAt,
});

const base64UrlEncode = (bytes: Uint8Array) => {
  let binary = "";

  bytes.forEach((byte) => {
    binary += String.fromCharCode(byte);
  });

  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
};

const randomToken = (byteLength: number) => {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return base64UrlEncode(bytes);
};

const sha256 = async (value: string) => {
  const digest = await crypto.subtle.digest("SHA-256", textEncoder.encode(value));
  return base64UrlEncode(new Uint8Array(digest));
};

const hashPassword = async (password: string, salt = randomToken(16)) => {
  const passwordKey = await crypto.subtle.importKey(
    "raw",
    textEncoder.encode(password),
    "PBKDF2",
    false,
    ["deriveBits"],
  );
  const bits = await crypto.subtle.deriveBits(
    {
      name: "PBKDF2",
      hash: "SHA-256",
      salt: textEncoder.encode(salt),
      iterations: PASSWORD_HASH_ITERATIONS,
    },
    passwordKey,
    256,
  );

  return {
    hash: base64UrlEncode(new Uint8Array(bits)),
    salt,
  };
};

const timingSafeEqual = (left: string, right: string) => {
  const leftBytes = textEncoder.encode(left);
  const rightBytes = textEncoder.encode(right);
  const length = Math.max(leftBytes.length, rightBytes.length);
  let difference = leftBytes.length ^ rightBytes.length;

  for (let index = 0; index < length; index += 1) {
    difference |= (leftBytes[index] ?? 0) ^ (rightBytes[index] ?? 0);
  }

  return difference === 0;
};

const parseStoredUser = (value: unknown) => {
  if (typeof value !== "string") {
    return null;
  }

  try {
    const parsed = JSON.parse(value) as Partial<StoredUser>;

    if (
      typeof parsed.id === "string" &&
      typeof parsed.email === "string" &&
      typeof parsed.name === "string" &&
      typeof parsed.createdAt === "string" &&
      typeof parsed.passwordHash === "string" &&
      typeof parsed.passwordSalt === "string"
    ) {
      return parsed as StoredUser;
    }
  } catch {
    return null;
  }

  return null;
};

const parseStoredSession = (value: unknown) => {
  if (typeof value !== "string") {
    return null;
  }

  try {
    const parsed = JSON.parse(value) as Partial<StoredSession>;

    if (
      typeof parsed.userId === "string" &&
      typeof parsed.createdAt === "string" &&
      typeof parsed.expiresAt === "string"
    ) {
      return parsed as StoredSession;
    }
  } catch {
    return null;
  }

  return null;
};

const parseStoredGuestSession = (value: unknown) => {
  const session = parseStoredSession(value);

  return session as StoredGuestSession | null;
};

const parseCookies = (request: Request) => {
  const cookieHeader = request.headers.get("Cookie") ?? "";

  return cookieHeader.split(";").reduce<Record<string, string>>((cookies, part) => {
    const [rawName, ...rawValue] = part.trim().split("=");

    if (!rawName) {
      return cookies;
    }

    cookies[rawName] = rawValue.join("=");
    return cookies;
  }, {});
};

const makeCookie = (
  request: Request,
  name: string,
  token: string,
  maxAgeSeconds: number,
) => {
  const secure = new URL(request.url).protocol === "https:";

  return [
    `${name}=${token}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${maxAgeSeconds}`,
    secure ? "Secure" : "",
  ]
    .filter(Boolean)
    .join("; ");
};

const makeSessionCookie = (
  request: Request,
  token: string,
  maxAgeSeconds: number,
) => makeCookie(request, SESSION_COOKIE_NAME, token, maxAgeSeconds);

const makeExpiredSessionCookie = (request: Request) =>
  makeSessionCookie(request, "", 0);

const makeGuestSessionCookie = (
  request: Request,
  token: string,
  maxAgeSeconds: number,
) => makeCookie(request, GUEST_SESSION_COOKIE_NAME, token, maxAgeSeconds);

const makeExpiredGuestSessionCookie = (request: Request) =>
  makeGuestSessionCookie(request, "", 0);

const getBearerToken = (request: Request) => {
  const authorization = request.headers.get("Authorization") ?? "";
  const match = authorization.match(/^Bearer\s+(.+)$/i);

  return match?.[1]?.trim() || "";
};

const getClientIp = (request: Request) => {
  const forwardedFor = request.headers.get("X-Forwarded-For") ?? "";
  const forwardedIp = forwardedFor.split(",")[0]?.trim();

  return (
    request.headers.get("CF-Connecting-IP")?.trim() ||
    forwardedIp ||
    "unknown"
  );
};

const getGuestId = (request: Request) => {
  if (request.headers.get("X-ClinicScribe-Guest") !== "local") {
    return null;
  }

  const guestId = request.headers.get("X-ClinicScribe-Guest-Id")?.trim() ?? "";

  if (
    !/^guest_[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      guestId,
    )
  ) {
    return null;
  }

  return guestId;
};

const enforceRateLimit = async (
  env: AuthEnv,
  scope: string,
  identifier: string,
  limit: number,
  windowSeconds: number,
) => {
  const identifierHash = await sha256(identifier);
  const key = getRateLimitKey(scope, identifierHash);
  const result = await redisCommand(env, ["INCR", key]);
  const count =
    typeof result === "number"
      ? result
      : typeof result === "string"
        ? Number.parseInt(result, 10)
        : Number.NaN;

  if (count === 1) {
    await redisCommand(env, ["EXPIRE", key, windowSeconds]);
  }

  if (!Number.isFinite(count)) {
    throw new AuthServiceError("Unable to enforce request limits.");
  }

  if (count > limit) {
    throw new AuthServiceError("Too many requests. Try again later.", 429);
  }
};

const getGuestUser = async (
  request: Request,
  env: AuthEnv,
): Promise<PublicUser | null> => {
  const guestId = getGuestId(request);

  if (!guestId) {
    return null;
  }

  const token = parseCookies(request)[GUEST_SESSION_COOKIE_NAME];

  if (!token) {
    return null;
  }

  const sessionHash = await sha256(token);
  const session = parseStoredGuestSession(
    await redisCommand(env, ["GET", getGuestSessionKey(sessionHash)]),
  );

  if (!session || session.userId !== guestId) {
    return null;
  }

  if (Date.parse(session.expiresAt) <= Date.now()) {
    await redisCommand(env, ["DEL", getGuestSessionKey(sessionHash)]);
    return null;
  }

  await enforceRateLimit(
    env,
    "guest-api",
    `${guestId}:${getClientIp(request)}`,
    GUEST_API_LIMIT,
    GUEST_API_WINDOW_SECONDS,
  );

  return {
    id: guestId,
    email: "local-guest",
    name: "Guest",
    createdAt: new Date().toISOString(),
    isGuest: true,
  };
};

const getNameFromSupabaseMetadata = (
  metadata: unknown,
  email: string,
) => {
  const record =
    metadata && typeof metadata === "object" && !Array.isArray(metadata)
      ? (metadata as Record<string, unknown>)
      : {};

  const name =
    typeof record.name === "string"
      ? record.name.trim()
      : typeof record.full_name === "string"
        ? record.full_name.trim()
        : "";

  return name || email;
};

const verifySupabaseUser = async (
  request: Request,
  env: AuthEnv,
): Promise<PublicUser | null> => {
  const accessToken = getBearerToken(request);

  if (!accessToken) {
    return null;
  }

  const { url, key } = getSupabaseConfig(env);
  const response = await fetch(`${url}/auth/v1/user`, {
    headers: {
      apikey: key,
      Authorization: `Bearer ${accessToken}`,
    },
  });

  if (response.status === 401 || response.status === 403) {
    return null;
  }

  let payload: SupabaseUserResponse;

  try {
    payload = (await response.json()) as SupabaseUserResponse;
  } catch {
    throw new AuthServiceError("Supabase returned an invalid auth response.");
  }

  if (!response.ok) {
    throw new AuthServiceError("Unable to verify Supabase authentication.");
  }

  if (typeof payload.id !== "string" || typeof payload.email !== "string") {
    return null;
  }

  return {
    id: payload.id,
    email: payload.email,
    name: getNameFromSupabaseMetadata(payload.user_metadata, payload.email),
    createdAt:
      typeof payload.created_at === "string"
        ? payload.created_at
        : new Date().toISOString(),
    accessToken,
  };
};

const normalizeEmail = (email: string) => email.trim().toLowerCase();

const validateAccountInput = (
  action: "signup" | "login",
  email: unknown,
  password: unknown,
  name?: unknown,
) => {
  if (typeof email !== "string" || !email.trim()) {
    return "Email is required.";
  }

  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizeEmail(email))) {
    return "Enter a valid email address.";
  }

  if (typeof password !== "string" || !password) {
    return "Password is required.";
  }

  if (password.length < 8) {
    return "Password must be at least 8 characters.";
  }

  if (password.length > 128) {
    return "Password must be 128 characters or fewer.";
  }

  if (action === "signup" && typeof name === "string" && name.length > 80) {
    return "Name must be 80 characters or fewer.";
  }

  return null;
};

const createUser = async (
  env: AuthEnv,
  input: { email: string; password: string; name?: string },
) => {
  const email = normalizeEmail(input.email);
  const userId = `user_${crypto.randomUUID()}`;
  const createdAt = new Date().toISOString();
  const password = await hashPassword(input.password);
  const user: StoredUser = {
    id: userId,
    email,
    name: input.name?.trim() || email,
    createdAt,
    passwordHash: password.hash,
    passwordSalt: password.salt,
  };

  const emailIndexResult = await redisCommand(env, [
    "SET",
    getEmailKey(email),
    userId,
    "NX",
  ]);

  if (emailIndexResult !== "OK") {
    throw new AuthServiceError("An account already exists for that email.", 409);
  }

  await redisCommand(env, ["SET", getUserKey(userId), JSON.stringify(user)]);

  return toPublicUser(user);
};

const verifyUserCredentials = async (
  env: AuthEnv,
  emailInput: string,
  password: string,
) => {
  const email = normalizeEmail(emailInput);
  const userId = await redisCommand(env, ["GET", getEmailKey(email)]);

  if (typeof userId !== "string") {
    return null;
  }

  const user = parseStoredUser(await redisCommand(env, ["GET", getUserKey(userId)]));

  if (!user) {
    return null;
  }

  const passwordCheck = await hashPassword(password, user.passwordSalt);

  return timingSafeEqual(passwordCheck.hash, user.passwordHash)
    ? toPublicUser(user)
    : null;
};

const createSession = async (
  request: Request,
  env: AuthEnv,
  user: PublicUser,
) => {
  const token = randomToken(32);
  const sessionHash = await sha256(token);
  const now = Date.now();
  const session: StoredSession = {
    userId: user.id,
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(now + SESSION_TTL_SECONDS * 1000).toISOString(),
  };

  await redisCommand(env, [
    "SET",
    getSessionKey(sessionHash),
    JSON.stringify(session),
    "EX",
    SESSION_TTL_SECONDS,
  ]);

  return makeSessionCookie(request, token, SESSION_TTL_SECONDS);
};

const createGuestSession = async (
  request: Request,
  env: AuthEnv,
  guestId: string,
) => {
  if (
    !/^guest_[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      guestId,
    )
  ) {
    throw new AuthServiceError("Invalid guest session.", 400);
  }

  await enforceRateLimit(
    env,
    "guest-session-create",
    getClientIp(request),
    GUEST_SESSION_CREATE_LIMIT,
    GUEST_SESSION_CREATE_WINDOW_SECONDS,
  );

  const token = randomToken(32);
  const sessionHash = await sha256(token);
  const now = Date.now();
  const session: StoredGuestSession = {
    userId: guestId,
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(now + GUEST_SESSION_TTL_SECONDS * 1000).toISOString(),
  };

  await redisCommand(env, [
    "SET",
    getGuestSessionKey(sessionHash),
    JSON.stringify(session),
    "EX",
    GUEST_SESSION_TTL_SECONDS,
  ]);

  return {
    cookie: makeGuestSessionCookie(request, token, GUEST_SESSION_TTL_SECONDS),
    user: {
      id: guestId,
      email: "local-guest",
      name: "Guest",
      createdAt: session.createdAt,
      isGuest: true,
    } satisfies PublicUser,
  };
};

const destroySession = async (request: Request, env: AuthEnv) => {
  const token = parseCookies(request)[SESSION_COOKIE_NAME];

  if (!token) {
    return;
  }

  const sessionHash = await sha256(token);
  await redisCommand(env, ["DEL", getSessionKey(sessionHash)]);
};

const destroyGuestSession = async (request: Request, env: AuthEnv) => {
  const token = parseCookies(request)[GUEST_SESSION_COOKIE_NAME];

  if (!token) {
    return;
  }

  const sessionHash = await sha256(token);
  await redisCommand(env, ["DEL", getGuestSessionKey(sessionHash)]);
};

const getAuthenticatedUser = async (request: Request, env: AuthEnv) => {
  const guestUser = await getGuestUser(request, env);

  if (guestUser) {
    return guestUser;
  }

  const supabaseUser = await verifySupabaseUser(request, env);

  if (supabaseUser || getBearerToken(request)) {
    return supabaseUser;
  }

  const token = parseCookies(request)[SESSION_COOKIE_NAME];

  if (!token) {
    return null;
  }

  const sessionHash = await sha256(token);
  const session = parseStoredSession(
    await redisCommand(env, ["GET", getSessionKey(sessionHash)]),
  );

  if (!session) {
    return null;
  }

  if (Date.parse(session.expiresAt) <= Date.now()) {
    await redisCommand(env, ["DEL", getSessionKey(sessionHash)]);
    return null;
  }

  const user = parseStoredUser(
    await redisCommand(env, ["GET", getUserKey(session.userId)]),
  );

  return user ? toPublicUser(user) : null;
};

export const requireAuthenticatedUser = async (
  request: Request,
  env: AuthEnv,
) => {
  try {
    const user = await getAuthenticatedUser(request, env);

    if (!user) {
      return jsonResponse({ error: "Authentication required." }, { status: 401 });
    }

    return user;
  } catch (error) {
    return jsonResponse(
      {
        error:
          error instanceof AuthServiceError
            ? error.message
            : "Unable to verify authentication.",
      },
      { status: error instanceof AuthServiceError ? error.status : 500 },
    );
  }
};

const toAuthErrorResponse = (error: unknown) =>
  jsonResponse(
    {
      error:
        error instanceof AuthServiceError
          ? error.message
          : "Authentication service failed.",
    },
    { status: error instanceof AuthServiceError ? error.status : 500 },
  );

export const onRequestGet: PagesFunction<AuthEnv> = async ({ request, env }) => {
  try {
    const user = await getAuthenticatedUser(request, env);

    if (!user) {
      return jsonResponse({ error: "Authentication required." }, { status: 401 });
    }

    return jsonResponse({ user });
  } catch (error) {
    return toAuthErrorResponse(error);
  }
};

export const onRequestPost: PagesFunction<AuthEnv> = async ({ request, env }) => {
  let body: unknown;

  try {
    body = await request.json();
  } catch {
    return jsonResponse({ error: "Request body must be valid JSON." }, { status: 400 });
  }

  const action =
    body && typeof body === "object" && "action" in body
      ? (body as { action?: unknown }).action
      : undefined;
  const record =
    body && typeof body === "object" ? (body as Record<string, unknown>) : {};

  if (action === "logout") {
    try {
      await destroySession(request, env);
      await destroyGuestSession(request, env);

      const headers = new Headers();
      headers.append("Set-Cookie", makeExpiredSessionCookie(request));
      headers.append("Set-Cookie", makeExpiredGuestSessionCookie(request));

      return jsonResponse(
        { ok: true },
        {
          headers,
        },
      );
    } catch (error) {
      return toAuthErrorResponse(error);
    }
  }

  if (action === "guest") {
    const guestId = typeof record.guestId === "string" ? record.guestId.trim() : "";

    try {
      const guestSession = await createGuestSession(request, env, guestId);

      return jsonResponse(
        { user: guestSession.user },
        {
          headers: {
            "Set-Cookie": guestSession.cookie,
          },
        },
      );
    } catch (error) {
      return toAuthErrorResponse(error);
    }
  }

  if (action !== "signup" && action !== "login") {
    return jsonResponse({ error: "Unknown auth action." }, { status: 400 });
  }

  const validationError = validateAccountInput(
    action,
    record.email,
    record.password,
    record.name,
  );

  if (validationError) {
    return jsonResponse({ error: validationError }, { status: 400 });
  }

  const email = record.email as string;
  const password = record.password as string;
  const name = typeof record.name === "string" ? record.name : undefined;

  try {
    const user =
      action === "signup"
        ? await createUser(env, { email, password, name })
        : await verifyUserCredentials(env, email, password);

    if (!user) {
      return jsonResponse({ error: "Invalid email or password." }, { status: 401 });
    }

    const sessionCookie = await createSession(request, env, user);

    return jsonResponse(
      { user },
      {
        headers: {
          "Set-Cookie": sessionCookie,
        },
      },
    );
  } catch (error) {
    return toAuthErrorResponse(error);
  }
};
