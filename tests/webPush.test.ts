import assert from "assert";
import { getVapidPublicKey } from "../src/lib/webPush";

console.log("=== RUNNING VAPID WEB PUSH UNIT TESTS ===");

const key = getVapidPublicKey();
assert.ok(key, "VAPID Public Key must be non-empty");
assert.strictEqual(typeof key, "string", "VAPID Public Key must be a string");
assert.ok(key.length > 50, "VAPID Public Key must be base64url encoded string");

console.log("  ✓ VAPID Public Key verified:", key.slice(0, 20) + "...");
console.log("ALL VAPID WEB PUSH TESTS PASSED! 🎉\n");
