//! Parse hashrate and accepted/rejected share counts from a miner's console output.
//!
//! Nothing here ever guesses: a line that does not match yields no event, and the caller reports "unknown"
//! for anything never observed.

use crate::config::{MinerConfig, MinerKind};
use anyhow::{Context, Result};
use regex::Regex;

#[derive(Clone, Debug, PartialEq)]
pub enum MinerEvent {
    /// Current total hashrate in H/s as printed by the miner.
    Hashrate(f64),
    /// Cumulative counters since the miner process started (e.g. cpuminer's `accepted: 3/4`).
    SharesTotal {
        accepted: u64,
        rejected: u64,
    },
    /// Cumulative accepted-only / rejected-only counters (generic miners with `shares_cumulative = true`).
    AcceptedTotal(u64),
    RejectedTotal(u64),
    /// One accepted / rejected share (for miners that print one line per share).
    ShareAccepted,
    ShareRejected,
}

/// `1234.5 khash/sec`, `12 kH/s`, `3.2 MH/s`, `800 H/s`
pub const DEFAULT_HASHRATE_RE: &str = r"(?i)(?:^|[^\w.])(\d+(?:\.\d+)?)\s*([kmgtp]?)h(?:ash)?(?:es)?\s*/\s*s(?:ec)?\b";
const CPUMINER_SHARES_RE: &str = r"(?i)\baccepted:\s*(\d+)\s*/\s*(\d+)";
/// cpuminer-opt (JayDDee, the build shipped for Windows and Linux) share-result line, after colors are stripped:
/// `12 Accepted 12 S0 R0 B0, 3.456 sec (45ms)` for an accepted share, `13 A12 S0 Rejected 1 B0, ...` for a rejected one and
/// `14 A12 Stale 1 R1 B0, ...` for a stale one. The numbers are cumulative: accepted (A), stale (S), rejected (R), blocks (B).
const CPUMINER_OPT_SHARE_RE: &str =
    r"\b\d+\s+(?:Accepted\s+|A)(\d+)\s+(?:Stale\s+|S)(\d+)\s+(?:Rejected\s+|R)(\d+)\s+(?:BLOCK SOLVED\s+|B)\d+\b";
/// cpuminer-opt periodic report: `Hash rate   1.23kh/s   1.20kh/s   (1.21kh/s)`. The value in parentheses is the current
/// total of all threads; the first two are derived from share difficulty and the session average.
const CPUMINER_OPT_HASHRATE_RE: &str = r"(?i)\bhash rate\b.*\(\s*(\d+(?:\.\d+)?)\s*([kmgtp]?)h\s*/\s*s\s*\)";

/// Remove ANSI color / cursor escape sequences (`ESC [ ... letter`). cpuminer-opt prints colors by default, even when its
/// output is a pipe (turn them off with `--no-color`); they would otherwise split the numbers the parser looks for.
pub fn strip_ansi(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut chars = s.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '\u{1b}' {
            if chars.peek() == Some(&'[') {
                chars.next();
                // parameters/intermediates, then one final byte in 0x40..=0x7e
                for n in chars.by_ref() {
                    if ('@'..='~').contains(&n) {
                        break;
                    }
                }
            }
            continue;
        }
        out.push(c);
    }
    out
}

fn unit_multiplier(unit: &str) -> Option<f64> {
    Some(match unit.to_ascii_lowercase().as_str() {
        "" | "h" => 1.0,
        "k" => 1e3,
        "m" => 1e6,
        "g" => 1e9,
        "t" => 1e12,
        "p" => 1e15,
        _ => return None,
    })
}

/// Convert a printed value + unit to H/s. Rejects non-finite or absurd values.
pub fn to_hashrate(value: &str, unit: &str) -> Option<f64> {
    let v: f64 = value.parse().ok()?;
    let hs = v * unit_multiplier(unit)?;
    (hs.is_finite() && (0.0..=1e18).contains(&hs)).then_some(hs)
}

pub struct LineParser {
    kind: MinerKind,
    hashrate: Regex,
    shares_total: Option<Regex>,
    opt_shares: Option<Regex>,
    opt_hashrate: Option<Regex>,
    accepted: Option<Regex>,
    rejected: Option<Regex>,
    shares_cumulative: bool,
}

impl LineParser {
    pub fn new(cfg: &MinerConfig) -> Result<Self> {
        let compile = |name: &str, pat: &str| Regex::new(pat).with_context(|| format!("invalid regex in miner.{name}"));
        let hashrate = compile("hashrate_regex", cfg.hashrate_regex.as_deref().unwrap_or(DEFAULT_HASHRATE_RE))?;
        let (shares_total, accepted, rejected) = match cfg.kind {
            MinerKind::Cpuminer => (Some(compile("cpuminer", CPUMINER_SHARES_RE)?), None, None),
            MinerKind::Generic => (
                None,
                cfg.accepted_regex.as_deref().map(|p| compile("accepted_regex", p)).transpose()?,
                cfg.rejected_regex.as_deref().map(|p| compile("rejected_regex", p)).transpose()?,
            ),
        };
        let (opt_shares, opt_hashrate) = match cfg.kind {
            MinerKind::Cpuminer if cfg.hashrate_regex.is_none() => {
                (Some(compile("cpuminer", CPUMINER_OPT_SHARE_RE)?), Some(compile("cpuminer", CPUMINER_OPT_HASHRATE_RE)?))
            }
            MinerKind::Cpuminer => (Some(compile("cpuminer", CPUMINER_OPT_SHARE_RE)?), None),
            MinerKind::Generic => (None, None),
        };
        Ok(LineParser {
            kind: cfg.kind,
            hashrate,
            shares_total,
            opt_shares,
            opt_hashrate,
            accepted,
            rejected,
            shares_cumulative: cfg.shares_cumulative,
        })
    }

    /// True when this parser can ever produce share counts (otherwise they stay "unknown").
    pub fn reads_shares(&self) -> bool {
        self.shares_total.is_some() || self.opt_shares.is_some() || self.accepted.is_some() || self.rejected.is_some()
    }

    pub fn parse(&self, line: &str) -> Vec<MinerEvent> {
        let stripped = strip_ansi(line);
        let line = stripped.as_str();
        let mut out = Vec::new();

        // cpuminer-opt: cumulative counters on every share-result line. Pool-rejected = rejected + stale.
        if let Some(c) = self.opt_shares.as_ref().and_then(|re| re.captures(line)) {
            if let (Ok(acc), Ok(stale), Ok(rej)) = (c[1].parse::<u64>(), c[2].parse::<u64>(), c[3].parse::<u64>()) {
                out.push(MinerEvent::SharesTotal { accepted: acc, rejected: stale.saturating_add(rej) });
            }
        }
        // cpuminer-opt periodic report: take the live total in parentheses.
        if let Some(c) = self.opt_hashrate.as_ref().and_then(|re| re.captures(line)) {
            if let Some(hs) = to_hashrate(&c[1], c.get(2).map_or("", |m| m.as_str())) {
                out.push(MinerEvent::Hashrate(hs));
                return out;
            }
        }

        if let Some(c) = self.shares_total.as_ref().and_then(|re| re.captures(line)) {
            // cpuminer prints `accepted: <accepted>/<submitted>`; rejected = submitted - accepted.
            if let (Ok(acc), Ok(total)) = (c[1].parse::<u64>(), c[2].parse::<u64>()) {
                out.push(MinerEvent::SharesTotal { accepted: acc, rejected: total.saturating_sub(acc) });
            }
        }

        // cpuminer prints per-thread rates on other lines; only trust lines that report the total.
        let hashrate_line_ok = match self.kind {
            MinerKind::Cpuminer => {
                let l = line.to_ascii_lowercase();
                l.contains("accepted:") || l.contains("total") || l.contains("hash rate") || l.contains("hashrate")
            }
            MinerKind::Generic => true,
        };
        if hashrate_line_ok {
            if let Some(c) = self.hashrate.captures(line) {
                let unit = c.get(2).map_or("", |m| m.as_str());
                if let Some(hs) = to_hashrate(&c[1], unit) {
                    out.push(MinerEvent::Hashrate(hs));
                }
            }
        }

        if self.kind == MinerKind::Generic {
            for (re, accepted) in [(&self.accepted, true), (&self.rejected, false)] {
                let Some(re) = re else { continue };
                let Some(c) = re.captures(line) else { continue };
                if self.shares_cumulative {
                    if let Some(n) = c.get(1).and_then(|m| m.as_str().parse::<u64>().ok()) {
                        out.push(if accepted { MinerEvent::AcceptedTotal(n) } else { MinerEvent::RejectedTotal(n) });
                    }
                } else {
                    out.push(if accepted { MinerEvent::ShareAccepted } else { MinerEvent::ShareRejected });
                }
            }
        }
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cpuminer() -> LineParser {
        LineParser::new(&MinerConfig::default()).unwrap()
    }

    #[test]
    fn cpuminer_accepted_line_gives_shares_and_total_hashrate() {
        let ev = cpuminer().parse("[2026-10-31 16:00:00] accepted: 3/4 (75.00%), 1234.50 khash/sec (yay!!!)");
        assert_eq!(ev, vec![MinerEvent::SharesTotal { accepted: 3, rejected: 1 }, MinerEvent::Hashrate(1_234_500.0)]);
    }

    #[test]
    fn cpuminer_ignores_per_thread_lines() {
        assert!(cpuminer().parse("thread 0: 4096 hashes, 321.0 khash/sec").is_empty());
    }

    #[test]
    fn cpuminer_total_line() {
        assert_eq!(cpuminer().parse("Total: 5.34 kH/s"), vec![MinerEvent::Hashrate(5340.0)]);
    }

    #[test]
    fn unrelated_and_malformed_lines_yield_nothing() {
        let p = cpuminer();
        for l in ["", "Stratum difficulty set to 1024", "accepted: x/y", "total: NaN kH/s", "total 1e999 H/s"] {
            assert!(p.parse(l).is_empty(), "{l}");
        }
    }

    // ---- cpuminer-opt (JayDDee), the miner shipped for Windows: formats taken from its cpu-miner.c share_result() and
    // ---- report_summary_log() (v26.1).
    #[test]
    fn cpuminer_opt_share_result_lines_give_cumulative_counts() {
        let p = cpuminer();
        assert_eq!(
            p.parse("[2026-11-01 10:00:00] 12 Accepted 12 S0 R0 B0, 3.456 sec (45ms)"),
            vec![MinerEvent::SharesTotal { accepted: 12, rejected: 0 }]
        );
        assert_eq!(
            p.parse("[2026-11-01 10:00:09] 13 A12 S0 Rejected 1 B0, 2.100 sec (51ms)"),
            vec![MinerEvent::SharesTotal { accepted: 12, rejected: 1 }]
        );
        assert_eq!(
            p.parse("[2026-11-01 10:00:19] 14 A12 Stale 1 R1 B0, 9.900 sec (60ms)"),
            vec![MinerEvent::SharesTotal { accepted: 12, rejected: 2 }],
            "stale shares are shares the pool did not accept"
        );
        assert_eq!(
            p.parse("[2026-11-01 10:00:29] 15 A13 S1 R1 BLOCK SOLVED 1, 9.900 sec (60ms)"),
            vec![MinerEvent::SharesTotal { accepted: 13, rejected: 2 }]
        );
    }

    #[test]
    fn cpuminer_opt_colored_output_is_parsed_like_plain_output() {
        // cpuminer-opt colors by default, even into a pipe; this is the exact layout of its share_result() format string.
        let colored = "[2026-11-01 10:00:00]\u{1b}[01;37m 12 \u{1b}[01;32mAccepted 12 \u{1b}[0mS0 \u{1b}[0mR0 \u{1b}[0mB0\u{1b}[0m, 3.456 sec (45ms)\u{1b}[0m";
        assert_eq!(cpuminer().parse(colored), vec![MinerEvent::SharesTotal { accepted: 12, rejected: 0 }]);
        assert_eq!(strip_ansi("a\u{1b}[01;32mb\u{1b}[0mc"), "abc");
        assert_eq!(strip_ansi("no escapes, 100% [ok]"), "no escapes, 100% [ok]");
        assert_eq!(strip_ansi("trailing \u{1b}"), "trailing ");
    }

    #[test]
    fn cpuminer_opt_periodic_report_gives_the_live_total_hashrate() {
        let p = cpuminer();
        // columns: share-derived, session average, (live total of all threads)
        assert_eq!(
            p.parse("                     Hash rate         1.23kh/s     1.20kh/s   (1.21kh/s)"),
            vec![MinerEvent::Hashrate(1210.0)]
        );
        assert_eq!(p.parse("Hash rate       812.00h/s   790.50h/s   (801.00h/s)"), vec![MinerEvent::Hashrate(801.0)]);
        assert_eq!(p.parse("Hash rate        2.50Mh/s    2.40Mh/s   (2.45Mh/s)"), vec![MinerEvent::Hashrate(2_450_000.0)]);
        // other lines of the report carry no rate and must not produce events
        for l in [
            "Periodic Report     0:05:00        0:30:00",
            "Share rate        6.00/min     5.80/min",
            "Submitted            30           180",
            "Accepted             30           178       98.9%",
            "Thread 0, CPU 0: 1.20 kh/s",
        ] {
            assert!(p.parse(l).is_empty(), "{l}");
        }
        // benchmark-style total line still works
        assert_eq!(p.parse("[2026-11-01 10:00:00] Total: 5.34 kH/s"), vec![MinerEvent::Hashrate(5340.0)]);
    }

    #[test]
    fn units() {
        assert_eq!(to_hashrate("2", "M"), Some(2e6));
        assert_eq!(to_hashrate("2", ""), Some(2.0));
        assert_eq!(to_hashrate("2", "x"), None);
        assert_eq!(to_hashrate("1e30", "P"), None);
    }

    #[test]
    fn generic_without_share_regexes_never_reports_shares() {
        let cfg = MinerConfig { kind: MinerKind::Generic, ..MinerConfig::default() };
        let p = LineParser::new(&cfg).unwrap();
        assert!(!p.reads_shares());
        assert_eq!(p.parse("speed 10s: 800 H/s accepted"), vec![MinerEvent::Hashrate(800.0)]);
    }

    #[test]
    fn generic_per_line_shares() {
        let cfg = MinerConfig {
            kind: MinerKind::Generic,
            accepted_regex: Some(r"(?i)share accepted".into()),
            rejected_regex: Some(r"(?i)share rejected".into()),
            ..MinerConfig::default()
        };
        let p = LineParser::new(&cfg).unwrap();
        assert_eq!(p.parse("Share ACCEPTED (12ms)"), vec![MinerEvent::ShareAccepted]);
        assert_eq!(p.parse("share rejected: low diff"), vec![MinerEvent::ShareRejected]);
    }

    #[test]
    fn invalid_regex_is_a_config_error() {
        let cfg = MinerConfig { kind: MinerKind::Generic, accepted_regex: Some("(".into()), ..MinerConfig::default() };
        assert!(LineParser::new(&cfg).is_err());
    }
}
