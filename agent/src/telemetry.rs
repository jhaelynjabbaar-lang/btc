//! Local aggregation into `telemetry_1m` rows, a bounded offline buffer, and the batch request body.
//!
//! Honesty rules:
//! * A minute in which the miner ran but no hashrate was ever read produces NO row (the server column is NOT NULL and
//!   we refuse to invent a number).
//! * A minute in which the agent was paused (miner not running) produces a row with 0 H/s: that is a fact, not a guess.
//! * A stopped agent produces no rows.

use crate::commands::AgentState;
use crate::parse::MinerEvent;
use crate::timeutil::bucket_iso;
use serde::Serialize;
use serde_json::json;
use std::collections::VecDeque;

/// A hashrate reading older than this is "unknown", not "still current".
pub const HASHRATE_STALE_SECS: u64 = 180;
/// Worker accepts at most 120 rows per batch (2 hours of minutes); the buffer is bounded to the same size.
pub const MAX_BUFFER_ROWS: usize = 120;

#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct Row {
    #[serde(skip)]
    pub bucket_unix: u64,
    pub bucket_start: String,
    pub avg_hashrate_hs: f64,
    pub accepted: u64,
    pub rejected: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub difficulty: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub temperature_c: Option<f64>,
}

// ----------------------------------------------------------------- miner stats
/// Running totals for display and the source of per-minute share deltas. `None` = never observed = "unknown".
#[derive(Debug, Default)]
pub struct MinerStats {
    pub accepted: Option<u64>,
    pub rejected: Option<u64>,
    last_a: u64,
    last_r: u64,
    hashrate: Option<(f64, u64)>,
}

impl MinerStats {
    /// A new miner process starts counting from zero again.
    pub fn new_process(&mut self) {
        self.last_a = 0;
        self.last_r = 0;
        self.hashrate = None;
    }

    pub fn current_hashrate(&self, now: u64) -> Option<f64> {
        self.hashrate.filter(|(_, at)| now.saturating_sub(*at) <= HASHRATE_STALE_SECS).map(|(h, _)| h)
    }

    /// Add shares the POOL confirmed (accepted) or rejected, e.g. from the Stratum V2 translator's log.
    pub fn add_shares(&mut self, accepted: u64, rejected: u64) {
        if accepted > 0 {
            self.accepted = Some(self.accepted.unwrap_or(0) + accepted);
        }
        if rejected > 0 {
            self.rejected = Some(self.rejected.unwrap_or(0) + rejected);
        }
    }

    /// Apply one parsed event. Returns `(hashrate_sample, accepted_delta, rejected_delta)`.
    pub fn apply(&mut self, ev: &MinerEvent, now: u64) -> (Option<f64>, u64, u64) {
        let (mut da, mut dr) = (0, 0);
        let mut hr = None;
        match *ev {
            MinerEvent::Hashrate(h) => {
                self.hashrate = Some((h, now));
                hr = Some(h);
            }
            MinerEvent::SharesTotal { accepted, rejected } => {
                da = Self::delta(&mut self.last_a, accepted);
                dr = Self::delta(&mut self.last_r, rejected);
                self.accepted = Some(self.accepted.unwrap_or(0) + da);
                self.rejected = Some(self.rejected.unwrap_or(0) + dr);
            }
            MinerEvent::AcceptedTotal(n) => {
                da = Self::delta(&mut self.last_a, n);
                self.accepted = Some(self.accepted.unwrap_or(0) + da);
            }
            MinerEvent::RejectedTotal(n) => {
                dr = Self::delta(&mut self.last_r, n);
                self.rejected = Some(self.rejected.unwrap_or(0) + dr);
            }
            MinerEvent::ShareAccepted => {
                da = 1;
                self.accepted = Some(self.accepted.unwrap_or(0) + 1);
            }
            MinerEvent::ShareRejected => {
                dr = 1;
                self.rejected = Some(self.rejected.unwrap_or(0) + 1);
            }
        }
        (hr, da, dr)
    }

    /// Delta of a cumulative counter; a decrease means the miner restarted its counters: treat the value as new.
    fn delta(last: &mut u64, value: u64) -> u64 {
        let d = if value >= *last { value - *last } else { value };
        *last = value;
        d
    }
}

// ------------------------------------------------------------------ aggregator
#[derive(Debug, Default)]
pub struct Aggregator {
    cur_start: Option<u64>,
    hr_sum: f64,
    hr_n: u32,
    accepted: u64,
    rejected: u64,
    ran: bool,
    paused: bool,
    last_hr: Option<(f64, u64)>,
    ready: Vec<Row>,
    /// Minutes in which the miner ran but hashrate was unknown (no row sent).
    pub skipped_unknown: u64,
}

impl Aggregator {
    pub fn new() -> Self {
        Self::default()
    }

    fn roll(&mut self, now: u64) {
        let start = now - now % 60;
        match self.cur_start {
            None => self.cur_start = Some(start),
            Some(cur) if start > cur => {
                self.finalize(cur);
                self.cur_start = Some(start);
            }
            _ => {}
        }
    }

    fn finalize(&mut self, bucket_start: u64) {
        let end = bucket_start + 60;
        let hashrate = if self.ran {
            if self.hr_n > 0 {
                Some(self.hr_sum / f64::from(self.hr_n))
            } else {
                self.last_hr.filter(|(_, at)| end.saturating_sub(*at) <= HASHRATE_STALE_SECS).map(|(h, _)| h)
            }
        } else if self.paused {
            Some(0.0)
        } else {
            None
        };
        match hashrate {
            Some(h) if h.is_finite() && h >= 0.0 => self.ready.push(Row {
                bucket_unix: bucket_start,
                bucket_start: bucket_iso(bucket_start),
                avg_hashrate_hs: h,
                accepted: self.accepted,
                rejected: self.rejected,
                difficulty: None,
                temperature_c: None,
            }),
            _ if self.ran => self.skipped_unknown += 1,
            _ => {}
        }
        self.hr_sum = 0.0;
        self.hr_n = 0;
        self.accepted = 0;
        self.rejected = 0;
        self.ran = false;
        self.paused = false;
    }

    /// Call regularly (at least every few seconds) so every minute knows what state the agent was in.
    pub fn observe_state(&mut self, now: u64, state: AgentState, miner_running: bool) {
        self.roll(now);
        match state {
            AgentState::Mining if miner_running => self.ran = true,
            AgentState::Paused => self.paused = true,
            _ => {}
        }
    }

    pub fn record_hashrate(&mut self, now: u64, hs: f64) {
        self.roll(now);
        self.hr_sum += hs;
        self.hr_n += 1;
        self.last_hr = Some((hs, now));
    }

    pub fn record_shares(&mut self, now: u64, accepted: u64, rejected: u64) {
        self.roll(now);
        self.accepted += accepted;
        self.rejected += rejected;
    }

    /// Advance the clock and collect finished minute rows.
    pub fn take_ready(&mut self, now: u64) -> Vec<Row> {
        self.roll(now);
        std::mem::take(&mut self.ready)
    }

    /// The miner process was replaced: older readings belong to a different process.
    pub fn reset_hashrate_memory(&mut self) {
        self.last_hr = None;
    }
}

// --------------------------------------------------------------------- buffer
#[derive(Debug)]
pub struct TelemetryBuffer {
    rows: VecDeque<Row>,
    cap: usize,
    pub dropped: u64,
}

impl TelemetryBuffer {
    pub fn new(cap: usize) -> Self {
        TelemetryBuffer { rows: VecDeque::new(), cap: cap.clamp(1, MAX_BUFFER_ROWS), dropped: 0 }
    }

    pub fn len(&self) -> usize {
        self.rows.len()
    }

    pub fn is_empty(&self) -> bool {
        self.rows.is_empty()
    }

    /// Add a row. A row for a bucket already buffered replaces it; when full, the OLDEST row is dropped.
    pub fn push(&mut self, row: Row) {
        if let Some(existing) = self.rows.iter_mut().find(|r| r.bucket_unix == row.bucket_unix) {
            *existing = row;
            return;
        }
        self.rows.push_back(row);
        while self.rows.len() > self.cap {
            self.rows.pop_front();
            self.dropped += 1;
        }
    }

    /// The next batch to send (oldest first), not removed until `confirm`.
    pub fn batch(&self, max: usize) -> Vec<Row> {
        self.rows.iter().take(max.min(MAX_BUFFER_ROWS)).cloned().collect()
    }

    /// Remove the first `n` rows after the server accepted them.
    pub fn confirm(&mut self, n: usize) {
        for _ in 0..n.min(self.rows.len()) {
            self.rows.pop_front();
        }
    }
}

/// JSON body for `POST /v1/telemetry`. Keys are exactly what the Worker's validator allows.
pub fn batch_body(rows: &[Row], uptime_s: u64, software_version: &str) -> Vec<u8> {
    serde_json::to_vec(&json!({ "rows": rows, "uptime_s": uptime_s, "software_version": software_version }))
        .expect("telemetry body serializes")
}

#[cfg(test)]
mod tests {
    use super::*;

    const T0: u64 = 1_793_476_800; // minute aligned

    fn mining(a: &mut Aggregator, now: u64) {
        a.observe_state(now, AgentState::Mining, true);
    }

    #[test]
    fn averages_hashrate_and_sums_share_deltas_per_minute() {
        let mut a = Aggregator::new();
        mining(&mut a, T0 + 1);
        a.record_hashrate(T0 + 10, 1000.0);
        a.record_hashrate(T0 + 40, 2000.0);
        a.record_shares(T0 + 41, 2, 1);
        a.record_shares(T0 + 50, 1, 0);
        assert!(a.take_ready(T0 + 59).is_empty(), "minute not finished yet");
        let rows = a.take_ready(T0 + 61);
        assert_eq!(rows.len(), 1);
        let r = &rows[0];
        assert_eq!(r.bucket_start, "2026-10-31T20:00:00Z");
        assert_eq!((r.avg_hashrate_hs, r.accepted, r.rejected), (1500.0, 3, 1));
        assert_eq!(r.bucket_unix, T0);
    }

    #[test]
    fn unknown_hashrate_means_no_row_never_zero() {
        let mut a = Aggregator::new();
        mining(&mut a, T0 + 1);
        mining(&mut a, T0 + 30);
        assert!(a.take_ready(T0 + 61).is_empty());
        assert_eq!(a.skipped_unknown, 1);
    }

    #[test]
    fn fresh_previous_reading_carries_over_but_stale_one_does_not() {
        let mut a = Aggregator::new();
        mining(&mut a, T0 + 1);
        a.record_hashrate(T0 + 50, 800.0);
        mining(&mut a, T0 + 61); // minute 2 has no sample of its own
        mining(&mut a, T0 + 100);
        let rows = a.take_ready(T0 + 125);
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[1].avg_hashrate_hs, 800.0, "reading from 70 s before the minute ended is still fresh");
        for t in (T0 + 125..T0 + 400).step_by(5) {
            mining(&mut a, t);
        }
        let later = a.take_ready(T0 + 400);
        assert!(later.iter().all(|r| r.bucket_unix == T0 + 120), "only the minute that still had a fresh reading: {later:?}");
        assert!(a.skipped_unknown >= 2);
    }

    #[test]
    fn paused_minutes_report_zero_and_stopped_minutes_nothing() {
        let mut a = Aggregator::new();
        a.observe_state(T0 + 5, AgentState::Paused, false);
        let rows = a.take_ready(T0 + 65);
        assert_eq!(rows.len(), 1);
        assert_eq!((rows[0].avg_hashrate_hs, rows[0].accepted, rows[0].rejected), (0.0, 0, 0));
        a.observe_state(T0 + 70, AgentState::Stopped, false);
        assert!(a.take_ready(T0 + 130).is_empty());
        assert_eq!(a.skipped_unknown, 0);
    }

    #[test]
    fn miner_down_while_state_is_mining_gives_no_row() {
        let mut a = Aggregator::new();
        a.observe_state(T0 + 5, AgentState::Mining, false);
        assert!(a.take_ready(T0 + 65).is_empty());
    }

    #[test]
    fn stats_track_cumulative_counters_and_restarts() {
        let mut s = MinerStats::default();
        assert_eq!((s.accepted, s.rejected), (None, None));
        assert_eq!(s.apply(&MinerEvent::SharesTotal { accepted: 3, rejected: 1 }, T0), (None, 3, 1));
        assert_eq!(s.apply(&MinerEvent::SharesTotal { accepted: 5, rejected: 1 }, T0), (None, 2, 0));
        assert_eq!((s.accepted, s.rejected), (Some(5), Some(1)));
        s.new_process();
        assert_eq!(s.apply(&MinerEvent::SharesTotal { accepted: 1, rejected: 0 }, T0), (None, 1, 0));
        assert_eq!(s.accepted, Some(6));
        assert_eq!(s.apply(&MinerEvent::ShareRejected, T0), (None, 0, 1));
        assert_eq!(s.apply(&MinerEvent::Hashrate(10.0), T0).0, Some(10.0));
        assert_eq!(s.current_hashrate(T0 + 100), Some(10.0));
        assert_eq!(s.current_hashrate(T0 + 500), None, "stale reading is unknown");
    }

    fn row(i: u64) -> Row {
        Row {
            bucket_unix: T0 + i * 60,
            bucket_start: bucket_iso(T0 + i * 60),
            avg_hashrate_hs: i as f64,
            accepted: 0,
            rejected: 0,
            difficulty: None,
            temperature_c: None,
        }
    }

    #[test]
    fn buffer_is_bounded_drops_oldest_and_confirms_in_order() {
        let mut b = TelemetryBuffer::new(5);
        for i in 0..8 {
            b.push(row(i));
        }
        assert_eq!((b.len(), b.dropped), (5, 3));
        let batch = b.batch(100);
        assert_eq!(batch.first().unwrap().avg_hashrate_hs, 3.0, "oldest three were dropped");
        assert_eq!(b.batch(2).len(), 2);
        b.confirm(2);
        assert_eq!(b.batch(100).first().unwrap().avg_hashrate_hs, 5.0);
        b.confirm(99);
        assert!(b.is_empty());
    }

    #[test]
    fn buffer_keeps_rows_until_confirmed_and_replaces_same_bucket() {
        let mut b = TelemetryBuffer::new(10);
        b.push(row(1));
        let _failed_send = b.batch(10);
        assert_eq!(b.len(), 1, "a failed send must not lose rows");
        let mut r = row(1);
        r.accepted = 9;
        b.push(r);
        assert_eq!((b.len(), b.batch(1)[0].accepted), (1, 9));
        assert_eq!(TelemetryBuffer::new(10_000).batch(10_000).len(), 0);
    }

    #[test]
    fn body_matches_worker_schema() {
        let rows = vec![row(1), row(2)];
        let v: serde_json::Value = serde_json::from_slice(&batch_body(&rows, 90, "0.1.0")).unwrap();
        assert_eq!(
            v.as_object().unwrap().keys().cloned().collect::<std::collections::BTreeSet<_>>(),
            ["rows", "software_version", "uptime_s"].map(String::from).into()
        );
        let re = regex::Regex::new(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:00(?:\.000)?Z$").unwrap();
        for r in v["rows"].as_array().unwrap() {
            let keys: Vec<&String> = r.as_object().unwrap().keys().collect();
            assert!(
                keys.iter()
                    .all(|k| ["bucket_start", "avg_hashrate_hs", "accepted", "rejected", "difficulty", "temperature_c"]
                        .contains(&k.as_str()))
            );
            assert!(re.is_match(r["bucket_start"].as_str().unwrap()));
        }
        let full: Vec<Row> = (0..MAX_BUFFER_ROWS as u64).map(row).collect();
        assert!(batch_body(&full, 1, "0.1.0").len() < 32_768, "a full batch fits the Worker's 32 KB cap");
    }
}
