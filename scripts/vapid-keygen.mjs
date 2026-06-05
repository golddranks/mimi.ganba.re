#!/usr/bin/env node
// One-off: generate a VAPID keypair for Web Push.
//
//   ./scripts/vapid-keygen.mjs
//
// Paste the PUBLIC key into src/shared/vapid.js, and store the PRIVATE key as
// the worker secret (it never needs to be committed):
//
//   cd worker && npx wrangler secret put VAPID_PRIVATE_KEY
//
// Run again only to rotate — a new keypair invalidates every existing push
// subscription, so devices must re-subscribe.
const { subtle } = globalThis.crypto;

const b64url = (buf) =>
  Buffer.from(buf).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

const pair = await subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
const rawPub = await subtle.exportKey("raw", pair.publicKey);   // 65-byte 0x04‖X‖Y point
const jwk = await subtle.exportKey("jwk", pair.privateKey);

console.log("\nVAPID public key  → paste into src/shared/vapid.js (VAPID_PUBLIC_KEY):\n");
console.log("  " + b64url(rawPub));
console.log("\nVAPID private key → cd worker && npx wrangler secret put VAPID_PRIVATE_KEY");
console.log("  (paste this whole line as the secret value):\n");
console.log("  " + JSON.stringify({ kty: jwk.kty, crv: jwk.crv, d: jwk.d, x: jwk.x, y: jwk.y }) + "\n");
