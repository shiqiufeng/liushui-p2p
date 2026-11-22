import { Hono } from "hono";
import { Room } from "./room";

type ApiBindings = Env & {
  TURN_ID?: string;
  TURN_TOKEN?: string;
  METERED_DOMAIN?: string;
  METERED_API_KEY?: string;
  TURN_URLS?: string;
  TURN_USERNAME?: string;
  TURN_CREDENTIAL?: string;
};
type ApiContext = { Bindings: ApiBindings };

const app = new Hono<ApiContext>();

const SUPPORTED_LOCALES = ["en", "zh"] as const;
const DEFAULT_LOCALE = "en";
const LOCALE_COOKIE = "liushui_locale";
const LOCALE_COOKIE_MAX_AGE = 60 * 60 * 24 * 365;

type Locale = (typeof SUPPORTED_LOCALES)[number];

function isSupportedLocale(value: string | null | undefined): value is Locale {
  return SUPPORTED_LOCALES.includes(value as Locale);
}

function cookieValue(request: Request, name: string): string {
  const header = request.headers.get("cookie") ?? "";
  for (const part of header.split(";")) {
    const [key, ...value] = part.trim().split("=");
    if (key !== name) continue;
    try {
      return decodeURIComponent(value.join("="));
    } catch {
      return value.join("=");
    }
  }
  return "";
}

function requestLocale(request: Request): Locale {
  const acceptLanguage = request.headers.get("accept-language");
  if (acceptLanguage) {
    const preferred = acceptLanguage
      .split(",")
      .map((part) => part.trim().split(";")[0]?.toLowerCase() ?? "")
      .map((tag) => (tag.startsWith("zh") ? "zh" : tag.slice(0, 2)))
      .find(isSupportedLocale);
    if (preferred) return preferred;
  }

  const savedLocale = cookieValue(request, LOCALE_COOKIE);
  return isSupportedLocale(savedLocale) ? savedLocale : DEFAULT_LOCALE;
}

function localeCookie(locale: Locale): string {
  return `${LOCALE_COOKIE}=${locale}; Path=/; Max-Age=${LOCALE_COOKIE_MAX_AGE}; SameSite=Lax`;
}

function localizedResponse(request: Request, locale: Locale, assets: Fetcher): Promise<Response> {
  return assets.fetch(request).then((response) => {
    const headers = new Headers(response.headers);
    headers.append("Set-Cookie", localeCookie(locale));
    headers.set("Vary", "Cookie, Accept-Language");
    return new Response(response.body, { status: response.status, headers });
  });
}

app.get("/", (context) => {
  const url = new URL(context.req.raw.url);
  const locale = requestLocale(context.req.raw);
  url.pathname = `/${locale}`;
  const headers = new Headers({
    Location: url.toString(),
    Vary: "Cookie, Accept-Language",
  });
  headers.append("Set-Cookie", localeCookie(locale));
  return new Response(null, { status: 307, headers });
});

app.get("/en", (context) => localizedResponse(context.req.raw, "en", context.env.ASSETS));
app.get("/zh", (context) => localizedResponse(context.req.raw, "zh", context.env.ASSETS));

function roomIsValid(roomId: string | undefined): roomId is string {
  return /^\d{6}$/.test(roomId ?? "");
}

function roomFor(env: ApiBindings, roomId: string) {
  return env.ROOMS.getByName(roomId);
}

function localizedRoomResponse(context: { env: ApiBindings; req: { raw: Request; param: (name: string) => string } }, locale: Locale): Promise<Response> | Response {
  const roomId = context.req.param("roomId");
  if (!roomIsValid(roomId)) return Response.json({ message: "Invalid room ID." }, { status: 400 });
  return localizedResponse(context.req.raw, locale, context.env.ASSETS);
}

app.get("/room/:roomId", (context) => {
  const roomId = context.req.param("roomId");
  if (!roomIsValid(roomId)) return context.json({ message: "Invalid room ID." }, 400);

  const url = new URL(context.req.raw.url);
  const locale = requestLocale(context.req.raw);
  url.pathname = `/${locale}/room/${roomId}`;
  const headers = new Headers({ Location: url.toString(), Vary: "Cookie, Accept-Language" });
  headers.append("Set-Cookie", localeCookie(locale));
  return new Response(null, { status: 307, headers });
});

app.get("/en/room/:roomId", (context) => localizedRoomResponse(context, "en"));
app.get("/zh/room/:roomId", (context) => localizedRoomResponse(context, "zh"));

function methodNotAllowed(message: string): Response {
  return Response.json({ message }, { status: 405 });
}

app.get("/api/rooms/:roomId/status", async (context) => {
  const roomId = context.req.param("roomId");
  if (!roomIsValid(roomId)) return context.json({ message: "Invalid room ID." }, 400);

  const request = new Request(new URL("/status", context.req.url), { method: "GET" });
  const response = await roomFor(context.env, roomId).fetch(request);
  const headers = new Headers(response.headers);
  headers.set("Cache-Control", "no-store");
  return new Response(response.body, { status: response.status, headers });
});

app.all("/api/rooms/:roomId/status", () => methodNotAllowed("Method not allowed"));

app.get("/api/rooms/:roomId/ws", async (context) => {
  const roomId = context.req.param("roomId");
  if (!roomIsValid(roomId)) return context.json({ message: "Invalid room ID." }, 400);
  if (context.req.header("Upgrade") !== "websocket") {
    return context.json({ message: "Expected a WebSocket upgrade." }, 426);
  }

  return roomFor(context.env, roomId).fetch(context.req.raw);
});

type IceServer = { credential?: string; urls: string | string[]; username?: string };
type TurnProvider = "cloudflare" | "metered" | "static";

const TURN_SETUP_HINT =
  "Configure one relay source: Cloudflare TURN (TURN_ID + TURN_TOKEN), Metered TURN (METERED_DOMAIN + METERED_API_KEY), or a static relay (TURN_URLS + TURN_USERNAME + TURN_CREDENTIAL).";

function resolveTurnProvider(env: ApiBindings): TurnProvider | null {
  if (env.TURN_ID && env.TURN_TOKEN) return "cloudflare";
  if (env.METERED_DOMAIN && env.METERED_API_KEY) return "metered";
  if (env.TURN_URLS && env.TURN_USERNAME && env.TURN_CREDENTIAL) return "static";
  return null;
}

function normalizeIceServers(value: unknown): IceServer[] {
  if (!value) return [];
  const list = Array.isArray(value) ? value : [value];
  return list.filter((entry): entry is IceServer => {
    if (!entry || typeof entry !== "object") return false;
    const urls = (entry as IceServer).urls;
    return typeof urls === "string" || Array.isArray(urls);
  });
}

async function buildTurnIceServers(env: ApiBindings, provider: TurnProvider, ttl: number): Promise<IceServer[]> {
  if (provider === "static") {
    const urls = (env.TURN_URLS ?? "")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean);
    return urls.length > 0 ? [{ credential: env.TURN_CREDENTIAL, urls, username: env.TURN_USERNAME }] : [];
  }

  if (provider === "metered") {
    const response = await fetch(
      `https://${env.METERED_DOMAIN}/api/v1/turn/credentials?apiKey=${encodeURIComponent(env.METERED_API_KEY ?? "")}`,
      { method: "GET" },
    );
    if (!response.ok) {
      console.error(JSON.stringify({ event: "turn_credentials_failed", provider, status: response.status }));
      throw new Error(`TURN API request failed (${response.status})`);
    }
    return normalizeIceServers(await response.json());
  }

  const response = await fetch(
    `https://rtc.live.cloudflare.com/v1/turn/keys/${env.TURN_ID}/credentials/generate-ice-servers`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.TURN_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ ttl }),
    },
  );

  if (!response.ok) {
    console.error(JSON.stringify({ event: "turn_credentials_failed", provider, status: response.status }));
    throw new Error(`TURN API request failed (${response.status})`);
  }

  const body = (await response.json()) as { iceServers?: unknown };
  return normalizeIceServers(body.iceServers ?? body);
}

app.get("/api/turn/status", (context) => {
  const provider = resolveTurnProvider(context.env);
  return context.json({ configured: provider !== null, provider: provider ?? "none" });
});

app.post("/api/turn/credentials", async (context) => {
  const provider = resolveTurnProvider(context.env);
  if (!provider) {
    return context.json(
      {
        error: "TURN credentials are not configured.",
        message: TURN_SETUP_HINT,
        provider: "none",
      },
      500,
    );
  }

  const body = await context.req.json<{ ttl?: number }>().catch(() => ({ ttl: undefined }));
  const ttl = Math.min(Math.max(body.ttl ?? 86_400, 60), 86_400);

  try {
    const iceServers = await buildTurnIceServers(context.env, provider, ttl);
    if (iceServers.length === 0) {
      return context.json({ error: "TURN provider returned no ICE servers.", provider }, 502);
    }
    return context.json({ expiresIn: ttl, iceServers, provider });
  } catch (error) {
    return context.json(
      {
        error: "TURN credentials could not be generated.",
        message: error instanceof Error ? error.message : "Unknown TURN error.",
        provider,
      },
      502,
    );
  }
});

app.all("/api/turn/credentials", () => methodNotAllowed("Method not allowed"));
app.all("/api/turn/status", () => methodNotAllowed("Method not allowed"));

app.onError((error, context) => {
  console.error(JSON.stringify({ event: "api_error", path: context.req.path, message: error.message }));
  return context.json({ message: "服务器错误" }, 500);
});

export { Room };
export default app;
