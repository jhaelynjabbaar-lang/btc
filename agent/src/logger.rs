//! Plain-text log file + console echo. Everything the agent does is written here in readable form.

use crate::timeutil::{now_unix, rfc3339};
use std::fs::{File, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

const MAX_LOG_BYTES: u64 = 5 * 1024 * 1024;

struct Inner {
    path: PathBuf,
    file: Option<File>,
    echo: bool,
    written: u64,
}

#[derive(Clone)]
pub struct Logger {
    inner: Arc<Mutex<Inner>>,
}

/// Remove control characters (terminal escape sequences etc.) from text coming from child processes.
pub fn clean_line(s: &str) -> String {
    s.chars().filter(|c| !c.is_control() || *c == '\t').collect()
}

impl Logger {
    pub fn new(path: &Path, echo: bool) -> std::io::Result<Self> {
        let file = OpenOptions::new().create(true).append(true).open(path)?;
        let written = file.metadata().map(|m| m.len()).unwrap_or(0);
        Ok(Logger { inner: Arc::new(Mutex::new(Inner { path: path.to_path_buf(), file: Some(file), echo, written })) })
    }

    pub fn path(&self) -> PathBuf {
        self.inner.lock().unwrap().path.clone()
    }

    fn write(&self, level: &str, msg: &str, echo: bool) {
        let mut g = self.inner.lock().unwrap();
        let line = format!("{} {level:<5} {}", rfc3339(now_unix()), msg);
        if g.echo && echo {
            println!("{line}");
        }
        if g.written > MAX_LOG_BYTES {
            let rotated = g.path.with_extension("log.1");
            g.file = None;
            let _ = std::fs::rename(&g.path, rotated);
            g.file = OpenOptions::new().create(true).append(true).open(&g.path).ok();
            g.written = 0;
        }
        let n = line.len() as u64 + 1;
        if let Some(f) = g.file.as_mut() {
            let _ = writeln!(f, "{line}");
            g.written += n;
        }
    }

    pub fn info(&self, msg: impl AsRef<str>) {
        self.write("INFO", msg.as_ref(), true);
    }
    pub fn warn(&self, msg: impl AsRef<str>) {
        self.write("WARN", msg.as_ref(), true);
    }
    pub fn error(&self, msg: impl AsRef<str>) {
        self.write("ERROR", msg.as_ref(), true);
    }
    /// Output line from the miner process, written to the log file only (keeps the console readable; share lines are
    /// echoed by the caller through `info`).
    pub fn miner(&self, line: &str) {
        self.write("MINER", line, false);
    }

    /// A multi-line banner, printed and logged line by line.
    pub fn banner(&self, lines: &[String]) {
        let width = lines.iter().map(|l| l.chars().count()).max().unwrap_or(0).max(40) + 4;
        let bar = "=".repeat(width);
        self.write("INFO", &bar, true);
        for l in lines {
            self.write("INFO", &format!("  {l}"), true);
        }
        self.write("INFO", &bar, true);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn writes_plain_text_lines_with_timestamp_and_level() {
        let d = tempfile::tempdir().unwrap();
        let p = d.path().join("agent.log");
        let log = Logger::new(&p, false).unwrap();
        log.info("hello");
        log.miner("speed 1 kH/s");
        log.banner(&["A".into(), "B".into()]);
        let text = std::fs::read_to_string(&p).unwrap();
        let lines: Vec<&str> = text.lines().collect();
        assert!(lines[0].ends_with("INFO  hello") && lines[0].contains('T') && lines[0].contains('Z'));
        assert!(lines[1].ends_with("MINER speed 1 kH/s"));
        assert_eq!(lines.len(), 2 + 4);
    }

    #[test]
    fn clean_line_removes_escape_sequences() {
        assert_eq!(clean_line("a\u{1b}[31mred\u{7}\r"), "a[31mred");
    }
}
