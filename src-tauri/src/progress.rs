//! Pure progress accounting for audio renders.
//!
//! Everything here is free of Tauri/OS types so the whole codepath — cost
//! model, the ledger that turns completions into display snapshots, the
//! throttles, the ETA estimator, the notification body formatting — can be
//! exercised by `cargo test` with injected clocks and recording sinks. The
//! Tauri-facing glue lives in `render_notify` and the commands; it only
//! shuttles [`Snapshot`]s produced here.
//!
//! # Cost model
//!
//! Progress is measured in abstract **cost units**, not leaf nodes: TTS
//! synthesis time scales with the number of words in a `Text` leaf, while a
//! `Sound`/`Pause`/`Tone` leaf is a near-instant sample paste or buffer op.
//! A leaf therefore costs its word count (`Text`) or a small constant
//! (`PASTE_COST`). This keeps the bar's motion proportional to actual work —
//! a script of mostly sound-effect ticks no longer reads as "fast" progress
//! followed by a long frozen tail, and rate-based time estimates extrapolate
//! correctly (the rate is dominated by words/sec, and the remaining work is
//! mostly words).

use std::time::{Duration, Instant};

use crate::manifest::contains_split;
use crate::tag_parser::Node;

// ============================================================================
// Cost model
// ============================================================================

/// Cost of a leaf that only pastes/mixes pre-existing audio (sound effect,
/// silence pause, generated tone): effectively instant next to a TTS call.
pub const PASTE_COST: u64 = 1;

/// Number of whitespace-separated words in `text`.
pub fn word_count(text: &str) -> u64 {
    text.split_whitespace().count() as u64
}

/// Cost of a `Text` leaf: its word count (min 1 — even a single glyph goes
/// through the synthesizer).
pub fn text_cost(text: &str) -> u64 {
    word_count(text).max(1)
}

/// Which renderer's semantics an AST cost must mirror. The two paths differ
/// for constructs whose parts are NOT all synthesized:
///
/// - `<loop>`: the manifest walker bakes a loop over non-split content
///   `loops` times, but a loop WRAPPING a split (interactive descendant) is
///   synthesized once and repeated only at playback. The flat renderer
///   always repeats. Counting `loops ×` for the walker's wrapped case made
///   the pre-counted total unreachable — the bar stalled at `100/loops %`.
/// - `<random>`: the flat renderer synthesizes one (randomly chosen) part —
///   costed as the average of the parts; the walker synthesizes every part
///   (the player picks per playback) — costed as the sum.
/// - `<choice>`/`<react>`: flat renders the first/`main` part; the walker
///   renders all of them.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CountMode {
    /// Mirror the manifest walker (`AudioRenderer::render_manifest`).
    Walker,
    /// Mirror the flat renderer (`render_nodes`, used by `synthesize`).
    Flat,
}

/// Total cost of the leaves an AST render will synthesize, under `mode`'s
/// semantics. Empty `Text` costs nothing (both render paths skip it).
/// `Include` contributes 0 — the file-level pre-count
/// (`audio_renderer::count_render_cost`) resolves includes itself, skipping
/// fresh manifests exactly as the walker will.
pub fn ast_cost(nodes: &[Node], mode: CountMode) -> u64 {
    let mut total = 0;
    for node in nodes {
        match node {
            Node::Text(t) if !t.is_empty() => total += text_cost(t),
            Node::Text(_) => {}

            Node::Pause { .. } | Node::Sound { .. } | Node::Tone { .. } => {
                total += PASTE_COST;
            }

            Node::Voice { children, .. }
            | Node::Speed { children, .. }
            | Node::Volume { children, .. }
            | Node::Effect { children, .. }
            | Node::Background { children, .. }
            | Node::Section { children, .. }
            | Node::Beatmeter { children, .. }
            | Node::Visual { children, .. } => total += ast_cost(children, mode),

            // Non-split loops bake `loops` copies; loops around a split are
            // synthesized once (Walker). Flat always repeats. (See mode docs.)
            Node::Loop { loops, children } => {
                let inner = ast_cost(children, mode);
                let repeats = match mode {
                    CountMode::Flat => *loops as u64,
                    CountMode::Walker => {
                        if children.iter().any(contains_split) {
                            1
                        } else {
                            *loops as u64
                        }
                    }
                };
                total += inner * repeats;
            }

            Node::Overlay { parts, .. } => {
                for part in parts {
                    total += ast_cost(&part.children, mode);
                }
            }

            // Walker: every part renders. Flat: one random part — estimated
            // as the average.
            Node::Random { parts } => match mode {
                CountMode::Walker => {
                    for part in parts {
                        total += ast_cost(&part.children, mode);
                    }
                }
                CountMode::Flat => {
                    if !parts.is_empty() {
                        let sum: u64 = parts
                            .iter()
                            .map(|p| ast_cost(&p.children, mode))
                            .sum();
                        total += sum / parts.len() as u64;
                    }
                }
            },

            // All parts render on both paths (shuffled order on flat).
            Node::Scramble { parts } => {
                for part in parts {
                    total += ast_cost(&part.children, mode);
                }
            }

            // Walker: every option renders. Flat: the first option only.
            Node::Choice { options, .. } => match mode {
                CountMode::Walker => {
                    for part in options {
                        total += ast_cost(&part.children, mode);
                    }
                }
                CountMode::Flat => {
                    if let Some(first) = options.first() {
                        total += ast_cost(&first.children, mode);
                    }
                }
            },

            // Walker: main + fallback both render. Flat: main only.
            Node::React { parts, .. } => match mode {
                CountMode::Walker => {
                    for part in parts {
                        total += ast_cost(&part.children, mode);
                    }
                }
                CountMode::Flat => {
                    if let Some(main) = parts.iter().find(|p| p.role.as_deref() == Some("main")) {
                        total += ast_cost(&main.children, mode);
                    }
                }
            },

            // Both branches are always synthesized (the player picks one per
            // playback).
            Node::If {
                then_branch,
                r#else,
                ..
            } => {
                total += ast_cost(then_branch, mode);
                if let Some(else_nodes) = r#else {
                    total += ast_cost(else_nodes, mode);
                }
            }

            // `<until>` renders its children once; the waiting sound is one
            // more paste (the walker emits it as its own leaf tick).
            Node::Until {
                waiting_sound,
                children,
                ..
            } => {
                total += ast_cost(children, mode);
                if waiting_sound.is_some() {
                    total += PASTE_COST;
                }
            }

            Node::Include { .. } | Node::Rating { .. } => {}
        }
    }
    total
}

// ============================================================================
// Snapshot + ledger
// ============================================================================

/// One progress tick, ready for display. Everything downstream (the Tauri
/// event payload, the notification body, the pill) renders from this, so
/// display code stays trivial and the invariants live in exactly one place.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Snapshot {
    /// Cost units completed, clamped to `total` for display.
    pub done: u64,
    /// Seeded total cost; `0` = indeterminate (count failed / not seeded yet).
    pub total: u64,
    /// `done * 100 / total`, floor-rounded and **monotonic**: never decreases
    /// over a ledger's lifetime, never exceeds 100, even if the walker emits
    /// more cost than seeded (a construct the pre-count under-counts) or the
    /// total is re-seeded smaller mid-render.
    pub pct: u8,
    /// Human-readable label of the leaf or phase that produced this tick.
    pub label: String,
}

impl Snapshot {
    /// True once every seeded cost unit is done. Drives the throttle
    /// completion-bypass: the terminal tick must never be swallowed right
    /// behind a leaf tick, or the bar ends at N-1/N.
    pub fn is_complete(&self) -> bool {
        self.total > 0 && self.done >= self.total
    }
}

/// Accumulates completions into monotonic [`Snapshot`]s for one render.
pub struct Ledger {
    total: u64,
    done: u64,
    last_pct: u8,
}

impl Ledger {
    pub fn new() -> Self {
        Self {
            total: 0,
            done: 0,
            last_pct: 0,
        }
    }

    /// Seed the exact total cost (computed up front by the file pre-count).
    /// Called once, before synthesis starts.
    pub fn seed(&mut self, total: u64) {
        self.total = total;
    }

    /// Record `cost` units of work completed; returns the display snapshot.
    pub fn complete(&mut self, cost: u64, label: &str) -> Snapshot {
        self.done = self.done.saturating_add(cost);
        self.snapshot(label)
    }

    /// Relabel without advancing (pre-walk phases: reading, parsing, …).
    pub fn phase(&mut self, label: &str) -> Snapshot {
        self.snapshot(label)
    }

    /// Force completion: pins `done` to the seeded total (covers unaccounted
    /// paste work like beat click samples) so a finished render always reads
    /// 100% instead of stopping at 99 because some cost escaped the count.
    pub fn finish(&mut self, label: &str) -> Snapshot {
        if self.total > 0 {
            self.done = self.done.max(self.total);
        }
        self.snapshot(label)
    }

    fn snapshot(&mut self, label: &str) -> Snapshot {
        let done = self.done.min(self.total);
        // checked_div for the unseeded (total 0) case: pct stays 0 while the
        // render is indeterminate.
        let raw = done
            .checked_mul(100)
            .and_then(|n| n.checked_div(self.total))
            .unwrap_or(0) as u8;
        // Monotonic guard: a snapshot never reads below the previous one, even
        // if the raw fraction drops (total re-seeded larger mid-render).
        let pct = raw.max(self.last_pct).min(100);
        self.last_pct = pct;
        Snapshot {
            done,
            total: self.total,
            pct,
            label: label.to_string(),
        }
    }
}

impl Default for Ledger {
    fn default() -> Self {
        Self::new()
    }
}

// ============================================================================
// Throttle
// ============================================================================

/// Rate-limits a side effect (push event, notification update) by injecting
/// `Instant::now()` at the call site — so timing behavior is unit-testable
/// with synthetic instants instead of real sleeps.
#[derive(Debug)]
pub struct Throttle {
    interval: Duration,
    last: Option<Instant>,
}

impl Throttle {
    pub fn new(interval: Duration) -> Self {
        Self { interval, last: None }
    }

    /// True (and re-arms) when at least `interval` has elapsed since the last
    /// accepted call. The first call is always accepted.
    pub fn ready(&mut self, now: Instant) -> bool {
        let due = match self.last {
            None => true,
            Some(last) => now.duration_since(last) >= self.interval,
        };
        if due {
            self.last = Some(now);
        }
        due
    }

    /// [`Self::ready`], except a completed snapshot always passes: the last
    /// leaf tick and the terminal tick can land within one interval, and the
    /// throttle must not eat the 100% landing.
    pub fn ready_or_complete(&mut self, now: Instant, snap: &Snapshot) -> bool {
        snap.is_complete() || self.ready(now)
    }
}

// ============================================================================
// ETA estimation
// ============================================================================

/// Estimates remaining seconds from the completion rate since synthesis
/// began. Clock-free: callers inject `Instant::now()` per observation.
///
/// The baseline is the FIRST observation that carries a seeded total —
/// pre-synthesis phases (engine acquisition, parsing, …) must not run the
/// clock, or early estimates are inflated by work that isn't progress. Until
/// cost has actually been completed past the baseline, no estimate exists
/// (phase relabels report `None` rather than inventing one).
#[derive(Debug, Default)]
pub struct EtaEstimator {
    baseline: Option<(Instant, u64)>,
    last: Option<u64>,
}

impl EtaEstimator {
    /// Record an observation; returns the estimated seconds remaining, or
    /// `None` until a rate exists. Every estimate refits the rate over the
    /// FULL window since the baseline, so a stalled render's estimate
    /// honestly rises instead of freezing.
    pub fn observe(&mut self, now: Instant, done: u64, total: u64) -> Option<u64> {
        if total == 0 {
            return None;
        }
        match self.baseline {
            None => {
                self.baseline = Some((now, done));
                None
            }
            Some((t0, d0)) => {
                let elapsed = now.duration_since(t0).as_secs_f64();
                let done_units = done.saturating_sub(d0);
                if elapsed <= 0.0 || done_units == 0 {
                    return self.last;
                }
                let rate = done_units as f64 / elapsed; // cost/sec
                let remaining = total.saturating_sub(done);
                let eta = (remaining as f64 / rate).ceil() as u64;
                self.last = Some(eta);
                self.last
            }
        }
    }
}

// ============================================================================
// Display formatting
// ============================================================================

/// Format seconds compactly as m:ss (h:mm:ss past the hour).
pub fn format_clock_secs(secs: u64) -> String {
    let s = secs;
    let h = s / 3600;
    let m = (s % 3600) / 60;
    let sec = s % 60;
    let two = |n: u64| format!("{:02}", n);
    if h > 0 {
        format!("{}:{}:{}", h, two(m), two(sec))
    } else {
        format!("{}:{}", m, two(sec))
    }
}

/// Body for the native render notification: `"<title> — 42% · ~3:20 left"`.
/// Cost units are meaningless to a human, so they are deliberately absent.
pub fn body_for(title: &str, snap: &Snapshot, eta_secs: Option<u64>) -> String {
    if snap.total == 0 {
        return title.to_string();
    }
    let mut s = format!("{} — {}%", title, snap.pct);
    if let Some(eta) = eta_secs {
        s.push_str(&format!(" · ~{} left", format_clock_secs(eta)));
    }
    s
}

// ============================================================================
// Tracker (walker-facing)
// ============================================================================

/// Receives every tick a render produces. Implementations decide throttling
/// and display; `Snapshot` already carries the clamped/monotonic numbers.
/// `FnMut` so a sink can own its throttle/ETA state without extra locking.
pub type ProgressSink = Box<dyn FnMut(&Snapshot) + Send>;

/// The walker-facing tracker: owns the ledger and forwards every snapshot to
/// a sink. Shared as `Arc<Mutex<…>>` across the render's call tree.
///
/// Cost units: `emit_leaf` is called by the render paths after each leaf —
/// Text leaves pass [`text_cost`], paste leaves pass [`PASTE_COST`] — and the
/// pre-count (`ast_cost` / `count_render_cost`) must mirror those calls
/// exactly.
pub struct ProgressTracker {
    pub ledger: Ledger,
    pub callback: ProgressSink,
}

impl ProgressTracker {
    /// Record one leaf's completion and forward its snapshot.
    pub fn emit_leaf(&mut self, cost: u64, label: &str) {
        let snap = self.ledger.complete(cost, label);
        (self.callback)(&snap);
    }

    /// Forward a phase relabel (no cost advance).
    pub fn emit_phase(&mut self, label: &str) {
        let snap = self.ledger.phase(label);
        (self.callback)(&snap);
    }

    /// Force the terminal 100% snapshot (always forwarded — completion
    /// bypasses any downstream throttle, see [`Snapshot::is_complete`]).
    pub fn finish(&mut self, label: &str) {
        let snap = self.ledger.finish(label);
        (self.callback)(&snap);
    }
}

// ============================================================================
// Tests
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tag_parser::SectionRole;

    fn parse(src: &str) -> Vec<Node> {
        crate::tag_parser::parse(src).expect("parse")
    }

    // ── Cost model ─────────────────────────────────────────────────────────

    #[test]
    fn word_count_uses_whitespace() {
        assert_eq!(word_count(""), 0);
        assert_eq!(word_count("   \n\t "), 0);
        assert_eq!(word_count("one"), 1);
        assert_eq!(word_count("hello,  world, three\nfour"), 4);
        // Unicode words split like any other whitespace-delimited token.
        assert_eq!(word_count("夜 と 暁"), 3);
    }

    #[test]
    fn text_cost_is_at_least_one() {
        assert_eq!(text_cost(""), 1); // guard: callers skip empty text anyway
        assert_eq!(text_cost("a"), 1);
        assert_eq!(text_cost("one two three four five"), 5);
    }

    #[test]
    fn ast_cost_counts_words_for_text_and_paste_cost_for_clips() {
        let nodes = parse("one two three <pause duration=\"1\"/><sound type=\"pop\"/>");
        assert_eq!(ast_cost(&nodes, CountMode::Walker), 3 + PASTE_COST * 2);
    }

    #[test]
    fn ast_cost_skips_empty_text() {
        let nodes = parse("");
        assert_eq!(ast_cost(&nodes, CountMode::Walker), 0);
    }

    #[test]
    fn walker_loop_over_plain_content_repeats() {
        // No split inside → the walker bakes all 3 copies (×2 words each).
        let nodes = parse("<loop loops=\"3\">two words</loop>");
        assert_eq!(ast_cost(&nodes, CountMode::Walker), 3 * 2);
    }

    #[test]
    fn walker_loop_wrapping_a_split_renders_once() {
        // A `<random>` inside the loop makes it a split wrapper: synthesized
        // once, repeated at playback. The old ×loops pre-count made the total
        // unreachable (bar stalling at 100/loops %).
        let nodes = parse(
            "<loop loops=\"10\"><random><part>two words</part><part>two words</part></random></loop>",
        );
        assert_eq!(ast_cost(&nodes, CountMode::Walker), 2 * 2);
        // …while the flat renderer really does repeat 10×.
        assert_eq!(ast_cost(&nodes, CountMode::Flat), 10 * 2);
    }

    #[test]
    fn walker_renders_every_random_part_flat_averages() {
        let src = "<random><part>one</part><part>a b c d</part></random>";
        let nodes = parse(src);
        assert_eq!(ast_cost(&nodes, CountMode::Walker), 1 + 4);
        // Flat picks one part at runtime; average = (1+4)/2 = 2.
        assert_eq!(ast_cost(&nodes, CountMode::Flat), 2);
    }

    #[test]
    fn choice_first_option_on_flat_all_on_walker() {
        let src = "<choice><part label=\"a\">one</part><part label=\"b\">a b c</part></choice>";
        let nodes = parse(src);
        assert_eq!(ast_cost(&nodes, CountMode::Walker), 1 + 3);
        assert_eq!(ast_cost(&nodes, CountMode::Flat), 1);
    }

    #[test]
    fn react_main_only_on_flat() {
        let src = concat!(
            "<react button=\"x\">",
            "<part role=\"main\">one</part>",
            "<part role=\"fallback\">a b c</part>",
            "</react>"
        );
        let nodes = parse(src);
        assert_eq!(ast_cost(&nodes, CountMode::Walker), 1 + 3);
        assert_eq!(ast_cost(&nodes, CountMode::Flat), 1);
    }

    #[test]
    fn scramble_sums_on_both_paths() {
        let nodes = parse("<scramble><part>one</part><part>a b c</part></scramble>");
        assert_eq!(ast_cost(&nodes, CountMode::Walker), 1 + 3);
        assert_eq!(ast_cost(&nodes, CountMode::Flat), 1 + 3);
    }

    #[test]
    fn if_sums_both_branches() {
        let nodes = vec![Node::If {
            cond: "true".into(),
            then_branch: parse("one"),
            r#else: Some(parse("a b")),
        }];
        assert_eq!(ast_cost(&nodes, CountMode::Walker), 1 + 2);
        assert_eq!(ast_cost(&nodes, CountMode::Flat), 1 + 2);
    }

    #[test]
    fn until_counts_children_plus_waiting_sound() {
        let nodes = vec![Node::Until {
            button: "go".into(),
            waiting_sound: Some("pop".into()),
            waiting_sound_volume: None,
            pre_pause: None,
            post_pause: None,
            children: parse("<pause duration=\"1\"/>"),
        }];
        assert_eq!(ast_cost(&nodes, CountMode::Walker), PASTE_COST + PASTE_COST);
    }

    #[test]
    fn containers_recurse_and_rating_include_cost_nothing() {
        let nodes = parse(
            "<voice speaker=\"a\">one two</voice><rating min=\"1\" max=\"5\"/><include src=\"x.xml\"/>",
        );
        assert_eq!(ast_cost(&nodes, CountMode::Walker), 2);
    }

    #[test]
    fn overlay_sums_parts_on_both_paths() {
        let src = "<overlay><part looped=\"true\">one</part><part>a b</part></overlay>";
        let nodes = parse(src);
        assert_eq!(ast_cost(&nodes, CountMode::Walker), 1 + 2);
        assert_eq!(ast_cost(&nodes, CountMode::Flat), 1 + 2);
    }

    #[test]
    fn visual_is_transparent_to_cost() {
        let nodes = vec![Node::Visual {
            config: crate::visual::VisualConfig {
                source: "redgifs".into(),
                niches: vec![],
                tags: vec![],
                block: vec![],
                query: None,
                order: None,
                every_min: 3.0,
                every_max: 6.0,
                count: 10,
                captions: "off".into(),
                effects: vec![],
                lines: vec![],
            },
            children: parse("one two"),
        }];
        assert_eq!(ast_cost(&nodes, CountMode::Walker), 2);
    }

    #[test]
    fn section_recurses() {
        let nodes = vec![Node::Section {
            role: SectionRole::Main,
            children: parse("one two three"),
        }];
        assert_eq!(ast_cost(&nodes, CountMode::Walker), 3);
    }

    // ── Ledger ─────────────────────────────────────────────────────────────

    #[test]
    fn ledger_unseeded_is_indeterminate() {
        let mut l = Ledger::new();
        let s = l.complete(5, "leaf");
        assert_eq!(s.total, 0);
        assert_eq!(s.pct, 0);
        assert!(!s.is_complete());
    }

    #[test]
    fn ledger_pct_advances_and_lands_exact() {
        let mut l = Ledger::new();
        l.seed(100);
        assert_eq!(l.complete(10, "a").pct, 10);
        assert_eq!(l.complete(15, "b").pct, 25);
        let s = l.complete(75, "c");
        assert_eq!(s.pct, 100);
        assert!(s.is_complete());
        assert_eq!(s.done, 100);
    }

    #[test]
    fn ledger_over_completion_clamps_at_100() {
        // A construct the pre-count under-counts must never read "110%".
        let mut l = Ledger::new();
        l.seed(10);
        assert_eq!(l.complete(20, "big").pct, 100);
        assert_eq!(l.complete(20, "more").pct, 100);
        assert_eq!(l.complete(20, "more").done, 10, "display clamps to total");
    }

    #[test]
    fn ledger_pct_never_regresses() {
        let mut l = Ledger::new();
        l.seed(100);
        l.complete(50, "half");
        // A pathological re-seed (larger total) must not move the bar back.
        l.seed(1000);
        let s = l.complete(1, "tiny");
        assert!(s.pct >= 50, "monotonic guard: got {}", s.pct);
    }

    #[test]
    fn ledger_phase_relabels_without_advancing() {
        let mut l = Ledger::new();
        l.seed(10);
        l.complete(1, "leaf");
        let s = l.phase("Parsing script…");
        assert_eq!(s.done, 1);
        assert_eq!(s.label, "Parsing script…");
    }

    #[test]
    fn ledger_finish_pins_100_despite_unaccounted_work() {
        // e.g. the beat click sample renders but is not part of the count.
        let mut l = Ledger::new();
        l.seed(10);
        l.complete(10, "all counted");
        let s = l.finish("Done");
        assert_eq!(s.pct, 100);
        assert!(s.is_complete());
        // Also lifts a render that ends below the seeded total.
        let mut l = Ledger::new();
        l.seed(10);
        l.complete(9, "most");
        assert_eq!(l.finish("Done").pct, 100);
    }

    // ── Throttle ───────────────────────────────────────────────────────────

    #[test]
    fn throttle_first_passes_then_gates_then_releases() {
        let t0 = Instant::now();
        let mut th = Throttle::new(Duration::from_millis(400));
        assert!(th.ready(t0));
        assert!(!th.ready(t0 + Duration::from_millis(399)));
        assert!(th.ready(t0 + Duration::from_millis(400)));
        assert!(!th.ready(t0 + Duration::from_millis(799)));
        assert!(th.ready(t0 + Duration::from_millis(800)));
    }

    #[test]
    fn throttle_completion_bypasses_gate() {
        let t0 = Instant::now();
        let mut th = Throttle::new(Duration::from_millis(400));
        assert!(th.ready(t0)); // first leaf tick
        let complete = Snapshot {
            done: 10,
            total: 10,
            pct: 100,
            label: "done".into(),
        };
        // Terminal tick lands 1ms later: must pass despite the gate…
        assert!(th.ready_or_complete(t0 + Duration::from_millis(1), &complete));
        // …and a plain tick in the same window must still be gated.
        let mid = Snapshot {
            done: 5,
            total: 10,
            pct: 50,
            label: "mid".into(),
        };
        assert!(!th.ready_or_complete(t0 + Duration::from_millis(2), &mid));
    }

    // ── ETA ────────────────────────────────────────────────────────────────

    #[test]
    fn eta_needs_a_seeded_total_and_progress() {
        let t0 = Instant::now();
        let mut eta = EtaEstimator::default();
        // Pre-synthesis phases (total 0) don't start the clock.
        assert_eq!(eta.observe(t0, 0, 0), None);
        assert_eq!(eta.observe(t0 + Duration::from_secs(9), 0, 0), None);
        // Baseline ticks when the total lands; no rate yet.
        assert_eq!(eta.observe(t0 + Duration::from_secs(10), 0, 100), None);
        // No progress since baseline → no estimate (sticky None).
        assert_eq!(eta.observe(t0 + Duration::from_secs(11), 0, 100), None);
    }

    #[test]
    fn eta_extrapolates_from_rate() {
        let t0 = Instant::now();
        let mut eta = EtaEstimator::default();
        eta.observe(t0, 0, 100);
        // 50 units in 10s → 5 u/s → 50 remaining → 10s.
        assert_eq!(eta.observe(t0 + Duration::from_secs(10), 50, 100), Some(10));
        // 40 more in 10s → rate 90/20 = 4.5 u/s → 10 remaining → ceil 3s.
        assert_eq!(eta.observe(t0 + Duration::from_secs(20), 90, 100), Some(3));
        // Completed: remaining 0.
        assert_eq!(eta.observe(t0 + Duration::from_secs(25), 100, 100), Some(0));
    }

    #[test]
    fn eta_stays_none_until_real_progress_exists() {
        let t0 = Instant::now();
        let mut eta = EtaEstimator::default();
        eta.observe(t0, 0, 100);
        // Phase relabels between the seed and the first finished leaf keep
        // reporting None — they must not invent an estimate from zero work.
        assert_eq!(eta.observe(t0 + Duration::from_secs(9), 0, 100), None);
    }

    #[test]
    fn eta_recomputes_from_the_full_window_when_progress_stalls() {
        let t0 = Instant::now();
        let mut eta = EtaEstimator::default();
        eta.observe(t0, 0, 100);
        assert_eq!(eta.observe(t0 + Duration::from_secs(10), 50, 100), Some(10));
        // A tick later with no NEW completed cost re-fits the rate over the
        // whole window (50 units / 11 s): the estimate honestly rises while
        // progress is stalled.
        assert_eq!(eta.observe(t0 + Duration::from_secs(11), 50, 100), Some(11));
    }

    // ── Formatting ─────────────────────────────────────────────────────────

    #[test]
    fn clock_formats_like_the_pill() {
        assert_eq!(format_clock_secs(0), "0:00");
        assert_eq!(format_clock_secs(45), "0:45");
        assert_eq!(format_clock_secs(723), "12:03");
        assert_eq!(format_clock_secs(4 * 3600 + 2 * 60 + 5), "4:02:05");
    }

    #[test]
    fn body_includes_pct_and_eta_but_not_cost_units() {
        let snap = Snapshot {
            done: 42,
            total: 100,
            pct: 42,
            label: "x".into(),
        };
        assert_eq!(body_for("main.xml", &snap, Some(200)), "main.xml — 42% · ~3:20 left");
        assert_eq!(body_for("main.xml", &snap, None), "main.xml — 42%");
        let indeterminate = Snapshot {
            done: 0,
            total: 0,
            pct: 0,
            label: "x".into(),
        };
        assert_eq!(body_for("main.xml", &indeterminate, Some(9)), "main.xml");
    }

    // ── Tracker (walker-facing integration) ────────────────────────────────

    /// Records every forwarded snapshot so tests can assert the exact
    /// sequence a sink would see.
    struct Recorder(std::sync::Mutex<Vec<Snapshot>>);

    impl Recorder {
        fn sink(self: &std::sync::Arc<Self>) -> ProgressSink {
            let rec = self.clone();
            Box::new(move |snap| rec.0.lock().unwrap().push(snap.clone()))
        }

        fn snaps(&self) -> Vec<Snapshot> {
            self.0.lock().unwrap().clone()
        }
    }

    #[test]
    fn tracker_forwards_monotonic_clamped_sequence_and_finishes_at_100() {
        let rec = std::sync::Arc::new(Recorder(std::sync::Mutex::new(vec![])));
        let mut tracker = ProgressTracker {
            ledger: Ledger::new(),
            callback: rec.sink(),
        };

        tracker.emit_phase("Entering worker…");
        tracker.ledger.seed(10);
        tracker.emit_leaf(7, "seven words");
        tracker.emit_phase("Parsing script…"); // relabels, no advance
        tracker.emit_leaf(1, "Sound: pop");
        tracker.emit_leaf(5, "over the count"); // 13 > 10 → clamp

        tracker.finish("Done");

        let snaps = rec.snaps();
        let mut last_pct = 0;
        for s in &snaps {
            assert!(s.pct <= 100, "pct above 100: {:?}", s);
            assert!(s.pct >= last_pct, "pct regressed: {:?}", s);
            assert!(s.done <= s.total, "done above total: {:?}", s);
            last_pct = s.pct;
        }
        assert_eq!(snaps.first().unwrap().total, 0, "pre-seed phase");
        assert_eq!(snaps[1].pct, 70);
        assert_eq!(snaps[2].pct, 70, "phase must not advance");
        assert_eq!(snaps[2].label, "Parsing script…");
        assert_eq!(snaps[3].pct, 80);
        assert_eq!(snaps[4].pct, 100, "clamped at total");
        let last = snaps.last().unwrap();
        assert_eq!(last.pct, 100);
        assert!(last.is_complete(), "finish must mark complete: {:?}", last);
    }

    #[test]
    fn tracker_completion_tick_is_flagged_for_throttle_bypass() {
        let mut l = Ledger::new();
        l.seed(4);
        assert!(!l.complete(2, "a").is_complete());
        assert!(l.complete(2, "b").is_complete());
        assert!(l.phase("relabeled").is_complete(), "completion is sticky");
    }
}
