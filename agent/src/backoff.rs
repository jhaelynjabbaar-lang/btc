use std::time::Duration;

/// Exponential backoff: `base * 2^(failures-1)`, capped at `max`.
#[derive(Clone, Debug)]
pub struct Backoff {
    base: Duration,
    max: Duration,
    failures: u32,
}

impl Backoff {
    pub fn new(base: Duration, max: Duration) -> Self {
        Backoff { base, max, failures: 0 }
    }

    pub fn failures(&self) -> u32 {
        self.failures
    }

    /// Record a failure and return the delay before the next attempt (no jitter).
    pub fn on_failure(&mut self) -> Duration {
        self.failures = self.failures.saturating_add(1);
        let shift = (self.failures - 1).min(20);
        self.base.saturating_mul(1u32 << shift).min(self.max)
    }

    pub fn on_success(&mut self) {
        self.failures = 0;
    }
}

/// Spread retries: scale `d` by a factor in [0.8, 1.2] using `unit` in [0, 1).
pub fn jitter(d: Duration, unit: f64) -> Duration {
    d.mul_f64(0.8 + 0.4 * unit.clamp(0.0, 1.0))
}

pub fn random_unit() -> f64 {
    let mut b = [0u8; 4];
    if getrandom::getrandom(&mut b).is_err() {
        return 0.5;
    }
    u32::from_le_bytes(b) as f64 / (u32::MAX as f64 + 1.0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn doubles_then_caps_and_resets() {
        let mut b = Backoff::new(Duration::from_secs(5), Duration::from_secs(60));
        let d: Vec<u64> = (0..6).map(|_| b.on_failure().as_secs()).collect();
        assert_eq!(d, vec![5, 10, 20, 40, 60, 60]);
        assert_eq!(b.failures(), 6);
        b.on_success();
        assert_eq!(b.on_failure().as_secs(), 5);
    }

    #[test]
    fn never_overflows() {
        let mut b = Backoff::new(Duration::from_secs(5), Duration::from_secs(300));
        for _ in 0..200 {
            assert!(b.on_failure() <= Duration::from_secs(300));
        }
    }

    #[test]
    fn jitter_bounds() {
        let d = Duration::from_secs(10);
        assert_eq!(jitter(d, 0.0), Duration::from_secs(8));
        assert!(jitter(d, 0.999) < Duration::from_secs(12));
    }
}
