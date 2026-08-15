use crate::protocol::{
    Activity, SourceStatus, HEARTBEAT_INTERVAL_MS, HEARTBEAT_TIMEOUT_MS, SOURCE_STALLED_AFTER_MS,
};
use std::time::Duration;

pub const VIEW_BYTES: usize = 5_460;
pub const VERSION_OFFSET: usize = 0;
pub const TICK_OFFSET: usize = 4;
pub const CONTEXT_LENGTH_OFFSET: usize = 1_104;
pub const CONTEXT_OFFSET: usize = 1_108;
pub const MAP_ID_OFFSET: usize = CONTEXT_OFFSET + 28;
pub const CONTEXT_MINIMUM_BYTES: u32 = 32;
pub const CONTEXT_BUFFER_BYTES: u32 = 256;
pub const SAMPLE_PAIR_ATTEMPTS: usize = 8;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Sample {
    pub tick: u32,
    pub map_id: u32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct Candidate {
    version: u32,
    tick: u32,
    context_length: u32,
    map_id: u32,
}

pub trait WordSource {
    fn read_word(&self, offset: usize) -> u32;
}

pub fn read_stable(source: &impl WordSource) -> Result<Sample, SourceStatus> {
    for _ in 0..SAMPLE_PAIR_ATTEMPTS {
        let first = read_candidate(source);
        let second = read_candidate(source);
        if first == second {
            return validate(second);
        }
    }
    Err(SourceStatus::SampleUnstable)
}

fn read_candidate(source: &impl WordSource) -> Candidate {
    Candidate {
        version: source.read_word(VERSION_OFFSET),
        tick: source.read_word(TICK_OFFSET),
        context_length: source.read_word(CONTEXT_LENGTH_OFFSET),
        map_id: source.read_word(MAP_ID_OFFSET),
    }
}

fn validate(candidate: Candidate) -> Result<Sample, SourceStatus> {
    if candidate.version != 2 {
        return Err(SourceStatus::LayoutUnsupported);
    }
    if !(CONTEXT_MINIMUM_BYTES..=CONTEXT_BUFFER_BYTES).contains(&candidate.context_length)
        || candidate.map_id == 0
    {
        return Err(SourceStatus::SampleInvalid);
    }
    Ok(Sample {
        tick: candidate.tick,
        map_id: candidate.map_id,
    })
}

#[derive(Default)]
pub struct ActivityClock {
    last_tick: Option<u32>,
    tick_started_at: Option<Duration>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Projection {
    Heartbeat(SourceStatus),
    Sample { sample: Sample, activity: Activity },
}

#[derive(Default)]
pub struct ProjectionClock {
    warmed: bool,
    activity: ActivityClock,
}

impl ProjectionClock {
    /// Projects exactly one cadence record. A discontinuity clears activity history.
    pub fn project(
        &mut self,
        observation: Result<Sample, SourceStatus>,
        now: Duration,
    ) -> Projection {
        match observation {
            Err(status) => {
                self.warmed = false;
                self.activity = ActivityClock::default();
                Projection::Heartbeat(status)
            }
            Ok(_) if !self.warmed => {
                self.warmed = true;
                self.activity = ActivityClock::default();
                Projection::Heartbeat(SourceStatus::WarmingUp)
            }
            Ok(sample) => Projection::Sample {
                activity: self.activity.observe(sample.tick, now),
                sample,
            },
        }
    }
}

impl ActivityClock {
    pub fn observe(&mut self, tick: u32, now: Duration) -> Activity {
        if self.last_tick != Some(tick) || self.tick_started_at.is_none() {
            self.last_tick = Some(tick);
            self.tick_started_at = Some(now);
            return Activity::Advancing;
        }

        if now.saturating_sub(self.tick_started_at.unwrap_or(now))
            >= Duration::from_millis(SOURCE_STALLED_AFTER_MS)
        {
            Activity::Stalled
        } else {
            Activity::Advancing
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CadenceDecision {
    NotDue,
    Due,
    HeartbeatTimeout,
}

/// Portable helper-side schedule. It emits no catch-up records after lateness.
pub struct CadenceSchedule {
    next_slot_at: Duration,
    last_sequenced_at: Duration,
    failed: bool,
}

impl CadenceSchedule {
    pub fn new(started_at: Duration) -> Self {
        Self {
            next_slot_at: started_at + Duration::from_millis(HEARTBEAT_INTERVAL_MS),
            last_sequenced_at: started_at,
            failed: false,
        }
    }

    pub fn poll(&mut self, now: Duration) -> CadenceDecision {
        if self.failed {
            return CadenceDecision::HeartbeatTimeout;
        }
        if now < self.next_slot_at {
            return CadenceDecision::NotDue;
        }
        if now.saturating_sub(self.last_sequenced_at) >= Duration::from_millis(HEARTBEAT_TIMEOUT_MS)
        {
            self.failed = true;
            return CadenceDecision::HeartbeatTimeout;
        }
        CadenceDecision::Due
    }

    pub fn record_emitted(&mut self, now: Duration) {
        self.last_sequenced_at = now;
        self.next_slot_at = now + Duration::from_millis(HEARTBEAT_INTERVAL_MS);
    }

    pub fn next_slot_at(&self) -> Duration {
        self.next_slot_at
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::Cell;

    struct Scripted {
        values: Vec<u32>,
        index: Cell<usize>,
    }

    impl WordSource for Scripted {
        fn read_word(&self, offset: usize) -> u32 {
            let expected = [
                VERSION_OFFSET,
                TICK_OFFSET,
                CONTEXT_LENGTH_OFFSET,
                MAP_ID_OFFSET,
            ];
            let index = self.index.get();
            assert_eq!(offset, expected[index % 4]);
            self.index.set(index + 1);
            self.values[index]
        }
    }

    #[test]
    fn reads_only_four_words_and_two_identical_candidates() {
        let source = Scripted {
            values: vec![2, 42, 48, 866, 2, 42, 48, 866],
            index: Cell::new(0),
        };
        assert_eq!(
            read_stable(&source),
            Ok(Sample {
                tick: 42,
                map_id: 866
            })
        );
        assert_eq!(source.index.get(), 8);
    }

    #[test]
    fn exhausts_exactly_eight_torn_pairs() {
        let mut values = Vec::new();
        for map_id in 1..=SAMPLE_PAIR_ATTEMPTS as u32 {
            values.extend([2, 42, 48, 866, 2, 42, 48, map_id]);
        }
        let source = Scripted {
            values,
            index: Cell::new(0),
        };
        assert_eq!(read_stable(&source), Err(SourceStatus::SampleUnstable));
        assert_eq!(source.index.get(), SAMPLE_PAIR_ATTEMPTS * 8);
    }

    #[test]
    fn validates_layout_and_rollover_activity() {
        for (values, expected) in [
            (
                vec![1, 42, 48, 866, 1, 42, 48, 866],
                SourceStatus::LayoutUnsupported,
            ),
            (
                vec![2, 42, 31, 866, 2, 42, 31, 866],
                SourceStatus::SampleInvalid,
            ),
            (
                vec![2, 42, 48, 0, 2, 42, 48, 0],
                SourceStatus::SampleInvalid,
            ),
        ] {
            let source = Scripted {
                values,
                index: Cell::new(0),
            };
            assert_eq!(read_stable(&source), Err(expected));
        }
        let mut clock = ActivityClock::default();
        assert_eq!(clock.observe(u32::MAX, Duration::ZERO), Activity::Advancing);
        assert_eq!(
            clock.observe(0, Duration::from_millis(500)),
            Activity::Advancing
        );
        assert_eq!(
            clock.observe(0, Duration::from_millis(1_999)),
            Activity::Advancing
        );
        assert_eq!(
            clock.observe(0, Duration::from_millis(2_000)),
            Activity::Stalled
        );
    }

    #[test]
    fn cadence_warms_once_and_discontinuity_resets_activity() {
        let valid = Sample {
            tick: 42,
            map_id: 866,
        };
        let mut projection = ProjectionClock::default();
        assert_eq!(
            projection.project(Ok(valid), Duration::from_millis(500)),
            Projection::Heartbeat(SourceStatus::WarmingUp)
        );
        assert_eq!(
            projection.project(Ok(valid), Duration::from_millis(1_000)),
            Projection::Sample {
                sample: valid,
                activity: Activity::Advancing
            }
        );
        assert_eq!(
            projection.project(Ok(valid), Duration::from_millis(2_499)),
            Projection::Sample {
                sample: valid,
                activity: Activity::Advancing
            }
        );
        assert_eq!(
            projection.project(Ok(valid), Duration::from_millis(2_500)),
            Projection::Sample {
                sample: valid,
                activity: Activity::Stalled
            }
        );
        assert_eq!(
            projection.project(
                Err(SourceStatus::SampleUnstable),
                Duration::from_millis(500)
            ),
            Projection::Heartbeat(SourceStatus::SampleUnstable)
        );
        assert_eq!(
            projection.project(Ok(valid), Duration::from_millis(500)),
            Projection::Heartbeat(SourceStatus::WarmingUp)
        );
        assert_eq!(
            projection.project(Ok(valid), Duration::from_millis(500)),
            Projection::Sample {
                sample: valid,
                activity: Activity::Advancing
            }
        );
    }

    #[test]
    fn every_source_failure_maps_to_its_exact_heartbeat_without_a_sample() {
        let mut projection = ProjectionClock::default();
        for status in [
            SourceStatus::MappingUnavailable,
            SourceStatus::LayoutUnsupported,
            SourceStatus::SampleUnstable,
            SourceStatus::SampleInvalid,
        ] {
            assert_eq!(
                projection.project(Err(status), Duration::from_millis(500)),
                Projection::Heartbeat(status),
            );
        }
    }

    #[test]
    fn cadence_starts_at_500_reschedules_from_now_and_times_out_exactly_at_2000() {
        let mut schedule = CadenceSchedule::new(Duration::ZERO);
        assert_eq!(
            schedule.poll(Duration::from_millis(499)),
            CadenceDecision::NotDue
        );
        assert_eq!(
            schedule.poll(Duration::from_millis(500)),
            CadenceDecision::Due
        );
        schedule.record_emitted(Duration::from_millis(500));

        assert_eq!(
            schedule.poll(Duration::from_millis(1_999)),
            CadenceDecision::Due
        );
        schedule.record_emitted(Duration::from_millis(1_999));
        assert_eq!(schedule.next_slot_at(), Duration::from_millis(2_499));
        assert_eq!(
            schedule.poll(Duration::from_millis(2_498)),
            CadenceDecision::NotDue
        );

        let mut timeout = CadenceSchedule::new(Duration::ZERO);
        assert_eq!(
            timeout.poll(Duration::from_millis(1_999)),
            CadenceDecision::Due
        );
        assert_eq!(
            timeout.poll(Duration::from_millis(2_000)),
            CadenceDecision::HeartbeatTimeout
        );
        assert_eq!(
            timeout.poll(Duration::from_secs(60)),
            CadenceDecision::HeartbeatTimeout
        );
    }
}
