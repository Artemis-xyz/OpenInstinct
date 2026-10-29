import { createHmac } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  PATHS,
  artemisConfig,
  artemisGet,
  createWebtoken,
} from "@agent/lib/artemis-data";
import { countRows, insufficient, query } from "@agent/tools/artemis";

const CONFIG = { baseUrl: "https://data-svc.test", seed: "nggy" };

function respond(body: unknown, init: { status?: number } = {}) {
  return vi.fn(
    async () =>
      new Response(JSON.stringify(body), {
        status: init.status ?? 200,
        headers: { "content-type": "application/json" },
      })
  ) as unknown as typeof fetch;
}

describe("artemis webtoken", () => {
  it("signs an HS256 JWT whose header matches the web app's", async () => {
    const [header, payload, signature] = (await createWebtoken("seed")).split(
      "."
    );
    const decode = (part: string) =>
      JSON.parse(Buffer.from(part, "base64url").toString("utf8"));

    // jose's setProtectedHeader({ alg }) emits no `typ`; data-svc verifies
    // over the exact bytes, so an extra field would fail verification.
    expect(decode(header)).toEqual({ alg: "HS256" });
    expect(signature).toMatch(/^[\w-]+$/u);

    const claims = decode(payload);
    expect(claims.exp - claims.iat).toBe(24 * 60 * 60);
  });

  it("signs with the rot13 of the seed, never the raw seed", async () => {
    // The web app rot13s the seed before signing. Signing with the raw value
    // would produce a token data-svc rejects on every single call, so this
    // recomputes the HMAC both ways and pins which one the signer used.
    const token = await createWebtoken("secret");
    const [header, payload, signature] = token.split(".");
    const signingInput = `${header}.${payload}`;

    const hmac = (key: string) =>
      createHmac("sha256", key).update(signingInput).digest("base64url");

    expect(signature).toBe(hmac("frperg")); // rot13("secret")
    expect(signature).not.toBe(hmac("secret"));
  });
});

describe("artemis config", () => {
  it("is null until both the URL and the seed are set", () => {
    expect(artemisConfig({} as NodeJS.ProcessEnv)).toBeNull();
    expect(
      artemisConfig({ ARTEMIS_DATA_SVC_URL: "https://x" } as NodeJS.ProcessEnv)
    ).toBeNull();
    expect(
      artemisConfig({ ARTEMIS_WEBTOKEN_SEED: "s" } as NodeJS.ProcessEnv)
    ).toBeNull();
  });

  it("trims a trailing slash so paths do not double up", () => {
    const config = artemisConfig({
      ARTEMIS_DATA_SVC_URL: "https://data-svc.test/",
      ARTEMIS_WEBTOKEN_SEED: "s",
    } as NodeJS.ProcessEnv);
    expect(config?.baseUrl).toBe("https://data-svc.test");
  });
});

describe("artemisGet", () => {
  it("sends the signed webtoken header", async () => {
    const fetchImpl = respond({ ok: true });
    await artemisGet("/x/", CONFIG, { fetchImpl });

    const [url, init] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock
      .calls[0];
    expect(url).toBe("https://data-svc.test/x/");
    expect((init.headers as Record<string, string>)["X-Art-Webtoken"]).toMatch(
      /^[\w-]+\.[\w-]+\.[\w-]+$/u
    );
  });

  it.each([
    [401, "auth"],
    [500, "500"],
  ])("turns HTTP %i into an unavailable notice", async (status, fragment) => {
    const result = await artemisGet("/x/", CONFIG, {
      fetchImpl: respond({ detail: "internal trace" }, { status }),
    });
    expect(result.status).toBe("unavailable");
    if (result.status !== "unavailable") return;
    expect(result.notice).toContain(fragment);
    // The upstream body can carry internal detail and the instructions forbid
    // pasting a raw error at the user.
    expect(result.notice).not.toContain("internal trace");
  });

  it("reports a timeout as unavailable rather than hanging the turn", async () => {
    const fetchImpl = vi.fn(
      (_url: string, init?: { signal?: AbortSignal }) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            const error = new Error("aborted");
            error.name = "AbortError";
            reject(error);
          });
        })
    ) as unknown as typeof fetch;

    const result = await artemisGet("/x/", CONFIG, {
      fetchImpl,
      timeoutMs: 25,
    });
    expect(result.status).toBe("unavailable");
    if (result.status !== "unavailable") return;
    expect(result.notice).toContain("did not respond in time");
  });
});

describe("request routing", () => {
  it.each([
    ["consensus_estimates", PATHS.ESTIMATES],
    ["financial_summary", PATHS.FINANCIALS],
    ["multiples_current", PATHS.VALUATION],
    ["next_earnings_date", PATHS.EARNINGS_PREVIEW],
  ] as const)("routes %s to its endpoint", (request, path) => {
    expect(query(request, "NVDA")).toContain(path);
  });

  it("asks for five years of multiples, the window the one-pager quotes", () => {
    expect(query("multiples_history", "NVDA")).toContain("years=5");
  });

  it("asks for enough price depth to measure performance since the last print", () => {
    // Yesterday's close alone cannot answer the preview's setup question.
    expect(query("price_history", "NVDA")).toContain("days=90");
  });

  it("separates last_quarter_results from the full financial history", () => {
    expect(query("last_quarter_results", "NVDA")).toContain("limit=1");
    expect(query("financial_summary", "NVDA")).not.toContain("limit=1");
  });

  it("escapes the ticker into the path", () => {
    expect(query("financial_summary", "BRK/B")).toContain("BRK%2FB");
  });
});

describe("insufficient-data guards", () => {
  it("refuses a 5yr range built from a short multiples history", () => {
    const short = { data: Array.from({ length: 6 }, (_, i) => ({ i })) };
    expect(insufficient("multiples_history", short)).toContain(
      "shorter than 5 years"
    );
  });

  it("accepts a full-length multiples history", () => {
    const full = { data: Array.from({ length: 60 }, (_, i) => ({ i })) };
    expect(insufficient("multiples_history", full)).toBeNull();
  });

  it.each(["BMO", "amc", "After Market Close"])(
    "accepts an earnings record carrying session %s",
    (session) => {
      expect(insufficient("next_earnings_date", { session })).toBeNull();
    }
  );

  it("blocks scheduling when the earnings record has no session", () => {
    // The summary fires hours after the call ends; the date alone cannot
    // produce that time, so a missing session is wrong, not partial.
    const notice = insufficient("next_earnings_date", {
      date: "2026-11-20",
    });
    expect(notice).toContain("market session");
    expect(notice).toContain("do not schedule");
  });

  it("leaves requests without a quoted-window contract alone", () => {
    expect(insufficient("consensus_estimates", {})).toBeNull();
  });
});

describe("countRows", () => {
  it.each([
    [[1, 2, 3], 3],
    [{ data: [1, 2] }, 2],
    [{ results: [1] }, 1],
    [{ history: [1, 2, 3, 4] }, 4],
    [{ nothing: true }, 0],
    [null, 0],
  ])("counts %j as %i", (payload, expected) => {
    expect(countRows(payload)).toBe(expected);
  });
});
