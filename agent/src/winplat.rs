//! Windows-only helpers (compiled only on Windows).
//!
//! * a restrictive ACL for the private key and the state directory (the Windows counterpart of mode 0600/0700),
//! * a Job Object so the miner / translator can never outlive the agent, and a tree-kill for explicit stops,
//! * a real "is this process alive" check.
//!
//! System tools are called by their absolute `%SystemRoot%\System32` path so a look-alike earlier on `PATH` cannot be run.

use anyhow::{Context, Result, bail};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::OnceLock;

/// `%SystemRoot%\System32` (falls back to `C:\Windows\System32`).
fn system32() -> PathBuf {
    let root = std::env::var_os("SystemRoot").or_else(|| std::env::var_os("windir")).unwrap_or_else(|| r"C:\Windows".into());
    PathBuf::from(root).join("System32")
}

/// The current user's SID as text (`S-1-5-21-...`), from `whoami /user`.
fn current_user_sid() -> Result<String> {
    let out = Command::new(system32().join("whoami.exe"))
        .args(["/user", "/fo", "csv", "/nh"])
        .stdin(Stdio::null())
        .stderr(Stdio::null())
        .output()
        .context("running whoami.exe")?;
    if !out.status.success() {
        bail!("whoami.exe failed ({})", out.status);
    }
    parse_whoami_sid(&String::from_utf8_lossy(&out.stdout)).context("could not read the current user's SID from whoami.exe")
}

/// `"DOMAIN\user","S-1-5-21-..."` -> `S-1-5-21-...`
pub fn parse_whoami_sid(text: &str) -> Option<String> {
    let line = text.lines().find(|l| l.contains("S-1-"))?;
    let sid = line.rsplit(',').next()?.trim().trim_matches('"').trim();
    (sid.starts_with("S-1-") && sid[4..].chars().all(|c| c.is_ascii_digit() || c == '-')).then(|| sid.to_string())
}

/// Make `path` (a file, or a directory with everything created inside it later) accessible to the current user only:
/// inheritance is removed and the sole entry is "full control for this user's SID".
pub fn restrict_to_current_user(path: &Path, is_dir: bool) -> Result<()> {
    let sid = current_user_sid()?;
    let grant = if is_dir { format!("*{sid}:(OI)(CI)F") } else { format!("*{sid}:F") };
    let out = Command::new(system32().join("icacls.exe"))
        .arg(path)
        .args(["/inheritance:r", "/grant:r"])
        .arg(grant)
        .stdin(Stdio::null())
        .output()
        .context("running icacls.exe")?;
    if !out.status.success() {
        bail!("icacls.exe failed on {} ({}): {}", path.display(), out.status, String::from_utf8_lossy(&out.stdout).trim());
    }
    Ok(())
}

/// Text of the access list of `path` (`icacls <path>`), for diagnostics and tests.
pub fn describe_acl(path: &Path) -> Result<String> {
    let out = Command::new(system32().join("icacls.exe")).arg(path).stdin(Stdio::null()).output().context("running icacls.exe")?;
    Ok(String::from_utf8_lossy(&out.stdout).into_owned())
}

// ------------------------------------------------------------------ job object
#[allow(dead_code)] // held only to keep the handle open for the life of the process
struct JobHandle(windows_sys::Win32::Foundation::HANDLE);
// SAFETY: a Job Object handle is just a kernel handle value; it is never dereferenced from Rust.
unsafe impl Send for JobHandle {}
unsafe impl Sync for JobHandle {}

static JOB: OnceLock<JobHandle> = OnceLock::new();

/// Put this process into a Job Object that kills every process in it when the last handle closes. Children started later
/// (miner, translator, anything they start) join the job automatically, so closing the console window, logging off or
/// killing the agent from Task Manager never leaves a miner running in the background. Idempotent.
pub fn kill_children_with_agent() -> Result<()> {
    use std::mem::{size_of, zeroed};
    use windows_sys::Win32::System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
        JobObjectExtendedLimitInformation, SetInformationJobObject,
    };
    use windows_sys::Win32::System::Threading::GetCurrentProcess;
    if JOB.get().is_some() {
        return Ok(());
    }
    // SAFETY: plain Win32 calls with valid arguments; the handle is stored for the life of the process.
    unsafe {
        let job = CreateJobObjectW(std::ptr::null(), std::ptr::null());
        if job.is_null() {
            return Err(std::io::Error::last_os_error()).context("CreateJobObjectW");
        }
        let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = zeroed();
        info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        if SetInformationJobObject(
            job,
            JobObjectExtendedLimitInformation,
            &info as *const _ as *const _,
            size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
        ) == 0
        {
            let e = std::io::Error::last_os_error();
            windows_sys::Win32::Foundation::CloseHandle(job);
            return Err(e).context("SetInformationJobObject");
        }
        if AssignProcessToJobObject(job, GetCurrentProcess()) == 0 {
            let e = std::io::Error::last_os_error();
            windows_sys::Win32::Foundation::CloseHandle(job);
            return Err(e).context("AssignProcessToJobObject");
        }
        let _ = JOB.set(JobHandle(job));
    }
    Ok(())
}

/// Kill `pid` and every process it started (`taskkill /T /F`). Best effort; returns whether taskkill reported success.
pub fn kill_process_tree(pid: u32) -> bool {
    Command::new(system32().join("taskkill.exe"))
        .args(["/PID", &pid.to_string(), "/T", "/F"])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map(|s| s.success())
        .unwrap_or(false)
}

/// Is a process with this id still running?
pub fn pid_alive(pid: u32) -> bool {
    use windows_sys::Win32::Foundation::{CloseHandle, STILL_ACTIVE};
    use windows_sys::Win32::System::Threading::{GetExitCodeProcess, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION};
    // SAFETY: OpenProcess/GetExitCodeProcess/CloseHandle with a handle we own.
    unsafe {
        let h = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
        if h.is_null() {
            // Access denied means the process exists but belongs to someone else; anything else means it is gone.
            return std::io::Error::last_os_error().raw_os_error() == Some(5);
        }
        let mut code: u32 = 0;
        let ok = GetExitCodeProcess(h, &mut code) != 0;
        CloseHandle(h);
        ok && code == STILL_ACTIVE as u32
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_whoami_csv() {
        assert_eq!(
            parse_whoami_sid("\"desktop-abc\\jane\",\"S-1-5-21-1111-2222-3333-1001\"\r\n").as_deref(),
            Some("S-1-5-21-1111-2222-3333-1001")
        );
        assert_eq!(parse_whoami_sid("garbage"), None);
        assert_eq!(parse_whoami_sid("\"a\",\"S-1-5-21-x; rm\""), None);
    }

    #[test]
    fn acl_is_limited_to_the_current_user() {
        let d = tempfile::tempdir().unwrap();
        let f = d.path().join("secret.key");
        std::fs::write(&f, "x").unwrap();
        restrict_to_current_user(&f, false).unwrap();
        let acl = describe_acl(&f).unwrap();
        for broad in ["Everyone", "BUILTIN\\Users", "Authenticated Users"] {
            assert!(!acl.contains(broad), "{broad} must not be in the ACL:\n{acl}");
        }
        // The owner can still read and delete it.
        assert_eq!(std::fs::read_to_string(&f).unwrap(), "x");
        std::fs::remove_file(&f).unwrap();
    }

    #[test]
    fn files_created_in_a_restricted_dir_inherit_the_restriction() {
        let d = tempfile::tempdir().unwrap();
        let dir = d.path().join("state");
        std::fs::create_dir(&dir).unwrap();
        restrict_to_current_user(&dir, true).unwrap();
        let f = dir.join("new.txt");
        std::fs::write(&f, "y").unwrap();
        let acl = describe_acl(&f).unwrap();
        assert!(!acl.contains("Everyone") && !acl.contains("BUILTIN\\Users"), "{acl}");
        assert_eq!(std::fs::read_to_string(&f).unwrap(), "y");
    }

    #[test]
    fn our_own_pid_is_alive_and_a_bogus_one_is_not() {
        assert!(pid_alive(std::process::id()));
        assert!(!pid_alive(0x7fff_fff0));
    }
}
