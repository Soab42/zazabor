// Zazabor's release key: an Ed25519 key that signs the content library's catalog and each update's
// manifest. The app checks both against the public key in src-tauri/src/signing.rs and uses
// nothing that isn't signed. The private key stays on the releasing computer, never in the repo:
// back it up somewhere safe. Without it no update can reach the copies already installed.
//
//   node tools/release/sign.mjs keygen        makes the key (once) and prints the public key
//   node tools/release/sign.mjs public        prints the public key
//   node tools/release/sign.mjs sign <file>   writes <file>.sig (the signature, base64)
//
// ZAZABOR_SIGNING_KEY names another key file (tests use a throwaway one).
import { createPrivateKey, createPublicKey, generateKeyPairSync, sign } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const KEY = process.env.ZAZABOR_SIGNING_KEY ?? join(homedir(), ".config", "zazabor-release", "signing-key.pem");

/** The public key as the app has it: the raw 32 bytes, base64. */
export function publicKeyOf(privatePem) {
  const jwk = createPublicKey(createPrivateKey(privatePem)).export({ format: "jwk" });
  return Buffer.from(jwk.x, "base64url").toString("base64");
}

/** The signature of `data` with the key at `keyPath`, base64. */
export function signature(data, keyPath = KEY) {
  if (!existsSync(keyPath)) throw new Error(`No signing key at ${keyPath}. Run: node tools/release/sign.mjs keygen`);
  return sign(null, data, createPrivateKey(readFileSync(keyPath))).toString("base64");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [command, file] = process.argv.slice(2);
  if (command === "keygen") {
    if (existsSync(KEY)) {
      console.error(`A key is already at ${KEY}; it was kept.`);
    } else {
      const { privateKey } = generateKeyPairSync("ed25519");
      mkdirSync(dirname(KEY), { recursive: true, mode: 0o700 });
      writeFileSync(KEY, privateKey.export({ format: "pem", type: "pkcs8" }), { mode: 0o600 });
      console.error(`Made ${KEY}. Back it up: updates can't be signed without it.`);
    }
    console.log(publicKeyOf(readFileSync(KEY)));
  } else if (command === "public") {
    console.log(publicKeyOf(readFileSync(KEY)));
  } else if (command === "sign" && file) {
    writeFileSync(`${file}.sig`, signature(readFileSync(file)) + "\n");
  } else {
    console.error("Usage: node tools/release/sign.mjs keygen | public | sign <file>");
    process.exit(2);
  }
}
