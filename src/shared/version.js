// Detect when a newer build has been deployed than the one currently running, so a
// page can nudge the user to reload. The running build's commit is injected at build
// time as window.BUILD_SHA (see scripts/build.py); /version.json carries the
// currently-deployed commit. They match on a fresh load and diverge once a deploy
// lands while a stale bundle is still cached (a PWA serves cached HTML for a while).
// A reload then revalidates and picks up the new bundle.
//
// Returns false (never nags) for a 'dev' build, when /version.json is missing, or
// when offline — only a confirmed, different deployed sha counts.
export async function updateAvailable() {
  const own = typeof window !== "undefined" && window.BUILD_SHA;
  if (!own || own === "dev") return false;
  try {
    const r = await fetch("/version.json", { cache: "no-store" });
    if (!r.ok) return false;
    const { sha } = await r.json();
    return !!sha && sha !== own;
  } catch {
    return false;
  }
}
