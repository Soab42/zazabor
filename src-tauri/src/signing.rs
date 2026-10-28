//! Zazabor's release key. The content library's catalog and each update's manifest are signed
//! with it (tools/release/sign.mjs keeps the private key on the releasing computer); what isn't
//! signed with it isn't used.

use base64::Engine;
use ring::signature::{UnparsedPublicKey, ED25519};

/// The public half of the release key (raw Ed25519, base64): `node tools/release/sign.mjs public`.
const PUBLIC_KEY: &str = "LTY9o6vjyaypZpE/uKJNHIYvG/37VnmVPTSDNutZTjc=";

/// Checks `signature` (base64, as `sign.mjs` writes it) over `data`.
pub fn verify(data: &[u8], signature: &str) -> Result<(), String> {
    verify_with(PUBLIC_KEY, data, signature)
}

fn verify_with(public_key: &str, data: &[u8], signature: &str) -> Result<(), String> {
    let b64 = base64::engine::general_purpose::STANDARD;
    let key = b64.decode(public_key).map_err(|e| e.to_string())?;
    let signature = b64.decode(signature.trim()).map_err(|_| "The signature isn't readable.".to_string())?;
    UnparsedPublicKey::new(&ED25519, key)
        .verify(data, &signature)
        .map_err(|_| "The download isn't signed by Zazabor, so it wasn't used.".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use ring::rand::SystemRandom;
    use ring::signature::{Ed25519KeyPair, KeyPair};

    fn new_pair() -> (Ed25519KeyPair, String) {
        let pkcs8 = Ed25519KeyPair::generate_pkcs8(&SystemRandom::new()).unwrap();
        let pair = Ed25519KeyPair::from_pkcs8(pkcs8.as_ref()).unwrap();
        let public = base64::engine::general_purpose::STANDARD.encode(pair.public_key().as_ref());
        (pair, public)
    }

    #[test]
    fn signed_data_passes_and_anything_else_fails() {
        let (pair, public) = new_pair();
        let sig = base64::engine::general_purpose::STANDARD.encode(pair.sign(b"catalog").as_ref());
        assert!(verify_with(&public, b"catalog", &format!("{sig}\n")).is_ok());
        assert!(verify_with(&public, b"catalog!", &sig).is_err());
        let (_, other) = new_pair();
        assert!(verify_with(&other, b"catalog", &sig).is_err());
        assert!(verify_with(&public, b"catalog", "not base64 ✗").is_err());
        // The app's own key is a well-formed Ed25519 public key.
        assert_eq!(base64::engine::general_purpose::STANDARD.decode(PUBLIC_KEY).unwrap().len(), 32);
    }

    /// `sign.mjs` (Node's Ed25519) and ring agree: a signature made by Node checks here.
    #[test]
    fn node_signatures_check() {
        let dir = std::env::temp_dir().join(format!("zazabor-sign-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let key = dir.join("key.pem");
        let script = concat!(env!("CARGO_MANIFEST_DIR"), "/../tools/release/sign.mjs");
        let run = |args: &[&str]| std::process::Command::new("node").arg(script).args(args).env("ZAZABOR_SIGNING_KEY", &key).output();
        let Ok(out) = run(&["keygen"]) else { return eprintln!("node isn't installed; skipped") };
        let public = String::from_utf8(out.stdout).unwrap();
        let file = dir.join("catalog.json");
        std::fs::write(&file, b"{\"kind\":\"zazabor-content\"}").unwrap();
        assert!(run(&["sign", file.to_str().unwrap()]).unwrap().status.success());
        let sig = std::fs::read_to_string(dir.join("catalog.json.sig")).unwrap();
        assert!(verify_with(public.trim(), &std::fs::read(&file).unwrap(), &sig).is_ok());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
