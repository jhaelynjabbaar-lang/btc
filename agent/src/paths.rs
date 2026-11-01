use anyhow::{Context, Result};
use std::path::{Path, PathBuf};

/// All local state lives in one directory in the OS config dir (e.g. `~/.config/btc-agent` on Linux,
/// `%LOCALAPPDATA%\BTC Network\btc-agent\config` on Windows: the per-machine, non-roaming profile folder, so the private key is
/// never copied to other PCs by a roaming profile). Override with `--home DIR` or `BTC_AGENT_HOME` (used by tests).
#[derive(Clone, Debug)]
pub struct Paths {
    pub dir: PathBuf,
}

impl Paths {
    pub fn new(dir: impl Into<PathBuf>) -> Self {
        Paths { dir: dir.into() }
    }

    pub fn resolve(override_dir: Option<&Path>) -> Result<Self> {
        if let Some(d) = override_dir {
            return Ok(Paths::new(d));
        }
        let pd = directories::ProjectDirs::from("ai", "BTC Network", "btc-agent")
            .context("could not determine the OS config directory; pass --home DIR")?;
        #[cfg(windows)]
        let dir = pd.config_local_dir();
        #[cfg(not(windows))]
        let dir = pd.config_dir();
        Ok(Paths::new(dir))
    }

    pub fn identity_key(&self) -> PathBuf {
        self.dir.join("identity.key")
    }
    pub fn worker_json(&self) -> PathBuf {
        self.dir.join("worker.json")
    }
    pub fn config(&self) -> PathBuf {
        self.dir.join("config.toml")
    }
    pub fn consent(&self) -> PathBuf {
        self.dir.join("consent.json")
    }
    pub fn status(&self) -> PathBuf {
        self.dir.join("status.json")
    }
    pub fn log(&self) -> PathBuf {
        self.dir.join("agent.log")
    }
    /// The translator proxy's generated config (rewritten on every start; contains no secrets).
    pub fn tproxy_config(&self) -> PathBuf {
        self.dir.join("tproxy.toml")
    }

    /// Every file the agent creates (used by `uninstall`).
    pub fn all_files(&self) -> Vec<PathBuf> {
        vec![
            self.identity_key(),
            self.worker_json(),
            self.config(),
            self.consent(),
            self.status(),
            self.log(),
            self.dir.join("agent.log.1"),
            self.tproxy_config(),
            self.dir.join("tproxy.toml.tmp"),
        ]
    }

    /// Create the state directory (0700 on unix; on Windows a newly created directory is limited to the current user).
    pub fn ensure_dir(&self) -> Result<()> {
        #[cfg(unix)]
        {
            use std::os::unix::fs::DirBuilderExt;
            std::fs::DirBuilder::new()
                .recursive(true)
                .mode(0o700)
                .create(&self.dir)
                .with_context(|| format!("creating {}", self.dir.display()))
        }
        #[cfg(not(unix))]
        {
            let existed = self.dir.exists();
            std::fs::create_dir_all(&self.dir).with_context(|| format!("creating {}", self.dir.display()))?;
            #[cfg(windows)]
            if !existed {
                // Files created inside inherit this, so the key is never readable by other users, even briefly.
                crate::winplat::restrict_to_current_user(&self.dir, true)
                    .with_context(|| format!("restricting access to {} to your user account", self.dir.display()))?;
            }
            #[cfg(not(windows))]
            let _ = existed;
            Ok(())
        }
    }
}
