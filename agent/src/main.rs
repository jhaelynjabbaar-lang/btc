use anyhow::Result;
use btc_agent::cmd::{self, EnrollArgs};
use btc_agent::paths::Paths;
use clap::{Parser, Subcommand};
use std::io::IsTerminal;
use std::path::PathBuf;

/// BTC Network AI worker agent. Consent-based and fully visible: it never hides mining.
#[derive(Parser)]
#[command(name = "btc-agent", version, about)]
struct Cli {
    /// State directory (default: the OS config dir, e.g. ~/.config/btc-agent).
    #[arg(long, global = true, env = "BTC_AGENT_HOME")]
    home: Option<PathBuf>,
    #[command(subcommand)]
    command: Cmd,
}

#[derive(Subcommand)]
enum Cmd {
    /// Generate a local key, enroll this machine with the server using a one-time code, save the worker id.
    Enroll {
        /// One-time enrollment code (BTCW-XXXXX-XXXXX-XXXXX-XXXXX), valid for 15 minutes.
        #[arg(long)]
        code: String,
        /// Ingest server URL.
        #[arg(long, default_value = btc_agent::DEFAULT_SERVER_URL)]
        server: String,
        /// Optional worker name shown in the dashboard.
        #[arg(long)]
        name: Option<String>,
        /// What this machine mines with: cpu or gpu.
        #[arg(long, default_value = "cpu")]
        hardware_type: String,
        /// Replace an existing local identity.
        #[arg(long)]
        force: bool,
    },
    /// Start the agent: runs the configured miner as a visible child process. Requires consent.
    Run {
        /// Start with mining paused until the server sends a `start` command.
        #[arg(long)]
        paused: bool,
    },
    /// Show enrollment, consent, config and whether the agent is running.
    Status,
    /// Show exactly what the agent does and record your typed "yes" locally.
    Consent {
        /// Withdraw consent (a running agent stops itself).
        #[arg(long)]
        revoke: bool,
    },
    /// Delete the local key, enrollment, config, consent and logs.
    Uninstall {
        /// Skip the typed confirmation.
        #[arg(long)]
        yes: bool,
    },
}

fn main() {
    if let Err(e) = real_main() {
        eprintln!("error: {e:#}");
        std::process::exit(1);
    }
}

fn real_main() -> Result<()> {
    let cli = Cli::parse();
    let paths = Paths::resolve(cli.home.as_deref())?;
    let stdin = std::io::stdin();
    let mut out = std::io::stdout();
    match cli.command {
        Cmd::Enroll { code, server, name, hardware_type, force } => {
            cmd::enroll(
                &paths,
                EnrollArgs { code: &code, server: &server, name: name.as_deref(), hardware_type: &hardware_type, force },
                &mut out,
            )?;
        }
        Cmd::Run { paused } => cmd::run_cmd(&paths, paused)?,
        Cmd::Status => cmd::status_cmd(&paths, &mut out)?,
        Cmd::Consent { revoke } => cmd::consent_cmd(&paths, revoke, &mut stdin.lock(), &mut out, stdin.is_terminal())?,
        Cmd::Uninstall { yes } => {
            cmd::uninstall_cmd(&paths, yes, &mut stdin.lock(), &mut out)?;
        }
    }
    Ok(())
}
