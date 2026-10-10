/**
 * HTTP client untuk creatok.ai — login otomatis, session self-heal,
 * throttle politeness, retry backoff.
 */
import {
  BASE_URL, UA, EMAIL, PASSWORD, THROTTLE_MS, MAX_RETRIES,
} from "./config";

let sessionCookie: string | null = null;
let sessionIssuedAt = 0;
const SESSION_MAX_AGE_MS = 6 * 24 * 3600 * 1000; // refresh proaktif sebelum 7 hari

let lastRequestAt = 0;

async function throttle() {
  const wait = THROTTLE_MS - (Date.now() - lastRequestAt);
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastRequestAt = Date.now();
}

export function getSessionInfo() {
  return {
    hasSession: !!sessionCookie,
    ageMs: sessionIssuedAt ? Date.now() - sessionIssuedAt : null,
  };
}

/** Login ke creatok.ai dan simpan session cookie. */
export async function login(): Promise<boolean> {
  const res = await fetch(`${BASE_URL}/api/auth/sign-in/email`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: BASE_URL,
      Referer: `${BASE_URL}/login`,
      "User-Agent": UA,
    },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
    redirect: "manual",
  });

  if (!res.ok) {
    console.error(`[client] login failed: HTTP ${res.status}`);
    return false;
  }

  const cookies = res.headers.getSetCookie?.() ?? [];
  const session = cookies.find((c) => c.startsWith("__Secure-better-auth.session_token="));
  if (!session) {
    console.error("[client] no session cookie in login response");
    return false;
  }
  const tokenPair = session.split(";")[0]; // name=value
  sessionCookie = tokenPair;
  sessionIssuedAt = Date.now();
  console.log(`[client] login ok (${EMAIL})`);
  return true;
}

/** Pastikan sesi valid: login jika belum ada / hampir kedaluwarsa. */
export async function ensureSession(force = false): Promise<boolean> {
  const expired =
    !sessionCookie || Date.now() - sessionIssuedAt > SESSION_MAX_AGE_MS;
  if (force || expired) {
    for (let attempt = 1; attempt <= 3; attempt++) {
      if (await login()) return true;
      await new Promise((r) => setTimeout(r, attempt * 3000));
    }
    return false;
  }
  return true;
}

interface FetchOpts {
  path: string;
  /** re-login sekali lalu coba lagi saat 401 */
  allowRelogin?: boolean;
}

/** GET dengan cookie sesi + retry backoff utk 429/5xx. */
export async function apiGet<T>({ path, allowRelogin = true }: FetchOpts): Promise<T | null> {
  if (!(await ensureSession())) return null;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    await throttle();
    let res: Response;
    try {
      res = await fetch(`${BASE_URL}${path}`, {
        headers: {
          Cookie: sessionCookie!,
          "User-Agent": UA,
          Accept: "application/json",
          Referer: `${BASE_URL}/app/trending`,
        },
      });
    } catch (e) {
      console.error(`[client] network error on ${path}:`, String(e));
      await new Promise((r) => setTimeout(r, 2000 * (attempt + 1)));
      continue;
    }

    if (res.status === 401 || res.status === 403) {
      if (allowRelogin) {
        console.warn("[client] session invalid — re-login");
        if (await ensureSession(true)) {
          return apiGet<T>({ path, allowRelogin: false });
        }
      }
      return null;
    }

    if (res.status === 429 || res.status >= 500) {
      const delay = Math.min(30000, 2000 * Math.pow(2.5, attempt));
      console.warn(`[client] HTTP ${res.status} — backoff ${delay}ms (${path.slice(0, 80)})`);
      await new Promise((r) => setTimeout(r, delay));
      continue;
    }

    if (!res.ok) {
      console.error(`[client] HTTP ${res.status} on ${path.slice(0, 100)}`);
      return null;
    }

    try {
      return (await res.json()) as T;
    } catch (e) {
      console.error("[client] bad JSON:", String(e));
      return null;
    }
  }
  return null;
}
