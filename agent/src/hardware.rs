//! Hardware info for enrollment: OS, arch, CPU model, cores, memory and (when easily detectable) the GPU name.

use serde_json::{Map, Value, json};
use std::process::{Command, Stdio};
use sysinfo::System;

#[derive(Clone, Debug, Default, PartialEq)]
pub struct HardwareInfo {
    pub os: Option<String>,
    pub arch: String,
    pub cpu_model: Option<String>,
    pub cpu_cores: Option<u32>,
    pub logical_cpus: usize,
    pub memory_mb: Option<u64>,
    pub gpu: Option<String>,
}

/// Printable ASCII/Unicode only, trimmed and truncated to `max` chars (the Worker rejects control characters).
pub fn sanitize(s: &str, max: usize) -> Option<String> {
    let cleaned: String = s.chars().filter(|c| !c.is_control()).collect();
    let t = cleaned.split_whitespace().collect::<Vec<_>>().join(" ");
    let t: String = t.chars().take(max).collect();
    (!t.is_empty()).then_some(t)
}

pub fn detect() -> HardwareInfo {
    let mut sys = System::new();
    sys.refresh_cpu_all();
    sys.refresh_memory();
    let logical = std::thread::available_parallelism().map(|n| n.get()).unwrap_or(1);
    let os = match (System::name(), System::os_version()) {
        (Some(n), Some(v)) => sanitize(&format!("{n} {v}"), 64),
        (Some(n), None) => sanitize(&n, 64),
        _ => sanitize(std::env::consts::OS, 64),
    };
    let mem = sys.total_memory() / (1024 * 1024);
    HardwareInfo {
        os,
        arch: std::env::consts::ARCH.to_string(),
        cpu_model: sys.cpus().first().and_then(|c| sanitize(c.brand(), 128)),
        cpu_cores: sys.physical_core_count().map(|c| c as u32).or(Some(logical as u32)),
        logical_cpus: logical,
        memory_mb: (mem > 0).then_some(mem),
        gpu: detect_nvidia_gpu(),
    }
}

/// Only NVIDIA via `nvidia-smi` (present when the driver is installed). Anything else: not detected, reported as absent.
fn detect_nvidia_gpu() -> Option<String> {
    let out = Command::new("nvidia-smi")
        .args(["--query-gpu=name", "--format=csv,noheader"])
        .stdin(Stdio::null())
        .stderr(Stdio::null())
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    let text = String::from_utf8_lossy(&out.stdout);
    let first = text.lines().next()?;
    sanitize(first, 128)
}

impl HardwareInfo {
    /// The `hardware` object of the enroll request (keys exactly as the Worker's validator allows).
    pub fn to_enroll_json(&self, hardware_type: &str, software_version: &str) -> Value {
        let mut m = Map::new();
        m.insert("hardware_type".into(), json!(hardware_type));
        if let Some(v) = &self.os {
            m.insert("os".into(), json!(v));
        }
        if let Some(a) = sanitize(&self.arch, 32) {
            m.insert("arch".into(), json!(a));
        }
        if let Some(v) = &self.cpu_model {
            m.insert("cpu_model".into(), json!(v));
        }
        if let Some(v) = self.cpu_cores {
            m.insert("cpu_cores".into(), json!(v.max(1)));
        }
        if let Some(v) = self.memory_mb {
            m.insert("memory_mb".into(), json!(v.max(1)));
        }
        if let Some(v) = &self.gpu {
            m.insert("gpu".into(), json!(v));
        }
        m.insert("software_version".into(), json!(software_version));
        Value::Object(m)
    }

    pub fn summary(&self) -> String {
        format!(
            "{} | {} | {} cores ({} threads) | {} | GPU: {}",
            self.os.as_deref().unwrap_or("unknown OS"),
            self.cpu_model.as_deref().unwrap_or("unknown CPU"),
            self.cpu_cores.map_or("?".into(), |c| c.to_string()),
            self.logical_cpus,
            self.memory_mb.map_or("unknown RAM".into(), |m| format!("{m} MB RAM")),
            self.gpu.as_deref().unwrap_or("none detected"),
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sanitize_strips_controls_and_truncates() {
        assert_eq!(sanitize("  Intel(R)\tCore\n i7  ", 128).as_deref(), Some("Intel(R)Core i7"));
        assert_eq!(sanitize("abcdef", 3).as_deref(), Some("abc"));
        assert_eq!(sanitize("\u{7}\u{1b}", 10), None);
    }

    #[test]
    fn enroll_json_only_uses_worker_allowed_keys() {
        let allowed = ["hardware_type", "os", "arch", "cpu_model", "cpu_cores", "memory_mb", "gpu", "software_version"];
        let hw = HardwareInfo {
            os: Some("Linux 6".into()),
            arch: "x86_64".into(),
            cpu_model: Some("Test CPU".into()),
            cpu_cores: Some(4),
            logical_cpus: 8,
            memory_mb: Some(16000),
            gpu: Some("Test GPU".into()),
        };
        let v = hw.to_enroll_json("cpu", "0.1.0");
        for k in v.as_object().unwrap().keys() {
            assert!(allowed.contains(&k.as_str()), "{k}");
        }
        assert_eq!(v["cpu_cores"], 4);
        assert_eq!(v["gpu"], "Test GPU");
        let minimal = HardwareInfo { arch: "x86_64".into(), logical_cpus: 1, ..Default::default() }.to_enroll_json("cpu", "0.1.0");
        assert!(minimal.get("gpu").is_none() && minimal.get("cpu_model").is_none());
    }

    #[test]
    fn detect_returns_something_plausible() {
        let hw = detect();
        assert!(hw.logical_cpus >= 1);
        assert!(!hw.arch.is_empty());
    }
}
