use time::OffsetDateTime;
use time::format_description::well_known::Rfc3339;

pub fn now_unix() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

/// RFC 3339 UTC timestamp, e.g. `2026-10-31T20:00:00Z`.
pub fn rfc3339(unix: u64) -> String {
    OffsetDateTime::from_unix_timestamp(unix as i64)
        .ok()
        .and_then(|t| t.format(&Rfc3339).ok())
        .unwrap_or_else(|| "1970-01-01T00:00:00Z".to_string())
}

/// Minute-aligned bucket start in the exact shape the ingest Worker accepts: `YYYY-MM-DDTHH:MM:00Z`.
pub fn bucket_iso(bucket_start_unix: u64) -> String {
    let fmt = time::macros::format_description!("[year]-[month]-[day]T[hour]:[minute]:00Z");
    OffsetDateTime::from_unix_timestamp((bucket_start_unix - bucket_start_unix % 60) as i64)
        .ok()
        .and_then(|t| t.format(&fmt).ok())
        .unwrap_or_else(|| "1970-01-01T00:00:00Z".to_string())
}

pub fn format_duration(secs: u64) -> String {
    let (d, h, m, s) = (secs / 86400, secs % 86400 / 3600, secs % 3600 / 60, secs % 60);
    if d > 0 {
        format!("{d}d{h:02}h{m:02}m")
    } else if h > 0 {
        format!("{h}h{m:02}m{s:02}s")
    } else if m > 0 {
        format!("{m}m{s:02}s")
    } else {
        format!("{s}s")
    }
}

/// Human readable hashrate from H/s. `None` is shown as `unknown` (never a made-up number).
pub fn format_hashrate(hs: Option<f64>) -> String {
    let Some(v) = hs else { return "unknown".to_string() };
    let units = ["H/s", "kH/s", "MH/s", "GH/s", "TH/s", "PH/s"];
    let mut x = v;
    let mut i = 0;
    while x >= 1000.0 && i < units.len() - 1 {
        x /= 1000.0;
        i += 1;
    }
    format!("{x:.2} {}", units[i])
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bucket_format_matches_worker_regex_shape() {
        // 2026-10-31T20:00:00Z
        assert_eq!(bucket_iso(1_793_476_800), "2026-10-31T20:00:00Z");
        assert_eq!(bucket_iso(1_793_476_800 + 45), "2026-10-31T20:00:00Z");
        assert_eq!(rfc3339(1_793_476_800), "2026-10-31T20:00:00Z");
    }

    #[test]
    fn formats() {
        assert_eq!(format_hashrate(None), "unknown");
        assert_eq!(format_hashrate(Some(1500.0)), "1.50 kH/s");
        assert_eq!(format_hashrate(Some(12.0)), "12.00 H/s");
        assert_eq!(format_duration(3725), "1h02m05s");
        assert_eq!(format_duration(59), "59s");
    }
}
