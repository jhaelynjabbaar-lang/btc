//! Local Ed25519 identity. The private key (32-byte seed) lives only in a private file in the config dir
//! (mode 0600 on Linux/macOS; on Windows an ACL that grants only your own user account access).
//! It is never logged, never printed and never sent anywhere; only the public key is shared (at enrollment).

use crate::protocol::b64url;
#[cfg(unix)]
use anyhow::bail;
use anyhow::{Context, Result};
use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use ed25519_dalek::{Signer, SigningKey};
use std::io::Write;
use std::path::Path;

/// Deliberately has no `Debug`/`Display`/`Clone` so the key cannot leak through formatting.
pub struct Identity {
    key: SigningKey,
}

impl Identity {
    pub fn generate() -> Self {
        let mut seed = [0u8; 32];
        getrandom::getrandom(&mut seed).expect("OS randomness unavailable");
        Identity::from_seed(seed)
    }

    pub fn from_seed(seed: [u8; 32]) -> Self {
        Identity { key: SigningKey::from_bytes(&seed) }
    }

    pub fn public_key_bytes(&self) -> [u8; 32] {
        self.key.verifying_key().to_bytes()
    }

    /// Raw 32-byte public key, unpadded base64url (what the Worker expects).
    pub fn public_key_b64url(&self) -> String {
        b64url(&self.public_key_bytes())
    }

    pub fn sign_b64url(&self, msg: &[u8]) -> String {
        b64url(&self.key.sign(msg).to_bytes())
    }

    /// Create the key file with mode 0600 from the first byte (no window where it is world-readable).
    /// On Windows the file is created inside the user-only state directory and then given an explicit user-only ACL; if
    /// that cannot be applied the key is deleted and an error is returned (it never stays on disk unprotected).
    /// Refuses to overwrite an existing key.
    pub fn save_new(&self, path: &Path) -> Result<()> {
        let mut opts = std::fs::OpenOptions::new();
        opts.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            opts.mode(0o600);
        }
        let mut f = opts.open(path).with_context(|| format!("creating key file {}", path.display()))?;
        let encoded = format!("{}\n", b64url(&self.key.to_bytes()));
        if let Err(e) = f.write_all(encoded.as_bytes()).and_then(|_| f.sync_all()) {
            drop(f);
            let _ = std::fs::remove_file(path);
            return Err(e).context("writing key file");
        }
        #[cfg(windows)]
        if let Err(e) = crate::winplat::restrict_to_current_user(path, false) {
            let _ = std::fs::remove_file(path);
            return Err(e).context("restricting the key file to your user account");
        }
        Ok(())
    }

    /// Load the key. On unix the file must not be readable or writable by group/other. (On Windows the ACL is set when
    /// the key is created and is not re-verified on every load.)
    pub fn load(path: &Path) -> Result<Self> {
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(path)
                .with_context(|| format!("reading {} (not enrolled? run `btc-agent enroll`)", path.display()))?
                .permissions()
                .mode();
            if mode & 0o077 != 0 {
                bail!(
                    "{} has unsafe permissions {:o}; it must be private. Run: chmod 600 {}",
                    path.display(),
                    mode & 0o777,
                    path.display()
                );
            }
        }
        let text = std::fs::read_to_string(path).with_context(|| format!("reading {}", path.display()))?;
        let bytes = URL_SAFE_NO_PAD.decode(text.trim()).context("identity key file is corrupt")?;
        let seed: [u8; 32] = bytes.try_into().map_err(|_| anyhow::anyhow!("identity key file is corrupt"))?;
        Ok(Identity::from_seed(seed))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn roundtrip_and_permissions() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("identity.key");
        let id = Identity::generate();
        id.save_new(&p).unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(std::fs::metadata(&p).unwrap().permissions().mode() & 0o777, 0o600);
        }
        let loaded = Identity::load(&p).unwrap();
        assert_eq!(loaded.public_key_b64url(), id.public_key_b64url());
        assert_eq!(loaded.sign_b64url(b"x"), id.sign_b64url(b"x"));
        assert!(id.save_new(&p).is_err(), "must not overwrite an existing key");
    }

    #[cfg(unix)]
    #[test]
    fn refuses_group_readable_key() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("identity.key");
        Identity::generate().save_new(&p).unwrap();
        std::fs::set_permissions(&p, std::fs::Permissions::from_mode(0o644)).unwrap();
        let err = Identity::load(&p).err().unwrap().to_string();
        assert!(err.contains("unsafe permissions"), "{err}");
    }

    #[test]
    fn public_key_is_32_bytes_base64url() {
        let k = Identity::generate().public_key_b64url();
        assert_eq!(k.len(), 43);
    }
}
