// Test-only: wrangler dev's local server occasionally drops a keep-alive socket
// under the suite's concurrent load (two test files hammering one worker), which
// surfaces as a transient `TypeError: fetch failed` / ECONNRESET — not a real
// failure. Retry such a fetch once, on a fresh connection.
//
// Safe because every worker endpoint the tests hit is either a GET or an
// idempotent upsert (/v1/user, /v1/push/subscribe) — EXCEPT /v1/events, whose
// insert is not idempotent: a double-POST would inflate the exact-count
// assertions, so it's never retried (a real /v1/events flake fails loudly).
//
// Only the test process's own fetches are wrapped (globalThis.fetch); pages
// driven in happy-dom use their window's fetch.
const real = globalThis.fetch;
const transient = (e) => /fetch failed/i.test(e?.message || "") || e?.cause?.code === "ECONNRESET";

globalThis.fetch = async (input, init) => {
  try {
    return await real(input, init);
  } catch (e) {
    const url = String(typeof input === "object" && input ? input.url : input);
    if (!transient(e) || url.includes("/v1/events")) throw e;
    return await real(input, init);
  }
};
