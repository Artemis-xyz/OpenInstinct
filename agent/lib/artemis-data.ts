/**
 * data-svc REST client for the Artemis warehouse tools.
 *
 * Lives in `agent/lib/`, not `agent/tools/`, on purpose: the eve runtime
 * registers every `.ts` file under `agent/tools/` as a tool by directory
 * convention — recursively, subdirectories included — so a helper placed
 * there would register as a phantom tool and break the boundary test.
 *
 * Auth mirrors the web app's scheme (artemis-invest-frontend
 * `src/lib/api/auth.ts`): an HS256 JWT with an empty claim set, signed with a
 * rot13 transform of a shared seed, sent as `X-Art-Webtoken`. Signed here with
 * WebCrypto rather than a JWT library so the fork gains no dependency for one
 * 80-byte token.
 *
 * Every secret comes from the environment. Nothing here reads a file, and no
 * seed or token is ever logged or returned to the model — a tool result goes
 * into the transcript, so anything returned is effectively disclosed.
 */

const TOKEN_TTL_SECONDS = 24 * 60 * 60;
const DEFAULT_TIMEOUT_MS = 15_000;

/** rot13, matching the web app's seed transform exactly. */
function rot13(message: string): string {
  return message.replace(/[a-z]/gi, (letter) =>
    String.fromCharCode(
      letter.charCodeAt(0) + (letter.toLowerCase() <= "m" ? 13 : -13)
    )
  );
}

function base64url(bytes: Uint8Array): string {
  return Buffer.from(bytes)
    .toString("base64")
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
}

/**
 * HS256 JWT with an empty claim set, matching `createWebtoken()`.
 *
 * The protected header is `{"alg":"HS256"}` with no `typ`, which is what
 * jose's `setProtectedHeader({ alg })` emits — data-svc verifies the
 * signature over the exact bytes, so an extra header field would not verify.
 */
export async function createWebtoken(seed: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(rot13(seed)),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );

  const issued = Math.floor(Date.now() / 1000);
  const encode = (value: object) =>
    base64url(new TextEncoder().encode(JSON.stringify(value)));
  const signingInput = `${encode({ alg: "HS256" })}.${encode({
    iat: issued,
    exp: issued + TOKEN_TTL_SECONDS,
  })}`;

  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(signingInput)
  );
  return `${signingInput}.${base64url(new Uint8Array(signature))}`;
}

export type ArtemisConfig = { baseUrl: string; seed: string };

/**
 * Resolved config, or null when the deployment has not been wired.
 *
 * Returning null rather than throwing is deliberate: an unwired deployment
 * must degrade into the honest "not wired" notice the instructions rely on,
 * not into an error the model might paraphrase as a data answer.
 */
export function artemisConfig(
  env: NodeJS.ProcessEnv = process.env
): ArtemisConfig | null {
  const baseUrl = env.ARTEMIS_DATA_SVC_URL?.trim();
  const seed = env.ARTEMIS_WEBTOKEN_SEED?.trim();
  if (!baseUrl || !seed) return null;
  return { baseUrl: baseUrl.replace(/\/+$/, ""), seed };
}

export type ArtemisFailure = {
  status: "unavailable";
  /** Safe to show the model: never contains the seed, token, or raw body. */
  notice: string;
};

export type ArtemisResult<T> = { status: "ok"; data: T } | ArtemisFailure;

/**
 * GET a data-svc path and return parsed JSON.
 *
 * Failures are normalized to a short notice. The upstream body is deliberately
 * not forwarded: it can carry internal detail, and the instructions tell the
 * model never to paste a raw error at the user.
 */
export async function artemisGet<T>(
  path: string,
  config: ArtemisConfig,
  options: { timeoutMs?: number; fetchImpl?: typeof fetch } = {}
): Promise<ArtemisResult<T>> {
  const { timeoutMs = DEFAULT_TIMEOUT_MS, fetchImpl = fetch } = options;
  const url = `${config.baseUrl}${path.startsWith("/") ? path : `/${path}`}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetchImpl(url, {
      headers: {
        "X-Art-Webtoken": await createWebtoken(config.seed),
        Accept: "application/json",
      },
      signal: controller.signal,
    });

    if (!response.ok) {
      return {
        status: "unavailable",
        notice:
          response.status === 401 || response.status === 403
            ? "The warehouse rejected the request (auth). Treat the number as unavailable."
            : `The warehouse returned ${response.status}. Treat the number as unavailable.`,
      };
    }
    return { status: "ok", data: (await response.json()) as T };
  } catch (error) {
    const aborted = error instanceof Error && error.name === "AbortError";
    return {
      status: "unavailable",
      notice: aborted
        ? "The warehouse did not respond in time. Treat the number as unavailable."
        : "The warehouse could not be reached. Treat the number as unavailable.",
    };
  } finally {
    clearTimeout(timer);
  }
}

/** The notice an unwired deployment returns, phrased for the model. */
export function notWired(detail: string): {
  status: "not_wired";
  notice: string;
} {
  return {
    status: "not_wired",
    notice:
      `Artemis warehouse access is not configured (set ARTEMIS_DATA_SVC_URL and ARTEMIS_WEBTOKEN_SEED). ` +
      detail,
  };
}

/** data-svc paths, mirroring artemis-invest-frontend `src/lib/api/endpoints.ts`. */
export const PATHS = {
  ESTIMATES: "/equities/estimates/",
  FINANCIALS: "/equities/financials/",
  EARNINGS_PREVIEW: "/equities/earnings-preview/",
  VALUATION: "/v2/equity-valuation/",
  COMPS_SUMMARY: "/equities/comps-summary/",
  HOLDINGS: "/portfolio/holdings/",
  ASSET: "/asset/",
} as const;
