// VAPID application-server public key — base64url of the raw P-256 point (the
// 65-byte 0x04‖X‖Y form). PUBLIC, safe to commit; the client passes it as the
// push `applicationServerKey` and the worker sends it as the VAPID `k=`. The
// matching PRIVATE key is a worker secret (env.VAPID_PRIVATE_KEY, a JWK) and is
// never committed. Generate a pair with `node scripts/vapid-keygen.mjs`, put the
// public half here and the private as the secret.
//
// Blank until set: with no key the client skips push subscription and the cron
// no-ops, so the rest of the app is unaffected.
export const VAPID_PUBLIC_KEY = "";
