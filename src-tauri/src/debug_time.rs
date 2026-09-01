//! Debug-only engine clock control ("time machine").
//!
//! Lets a debug build shift the engine's notion of "now" so scheduled
//! routines, lapse windows, habit day boundaries and store restocks can be
//! exercised without waiting for real time to pass. The offset is a plain
//! process-global: every engine read of the current time goes through
//! [`now`] (schedule.rs `utc_now`, economy.rs `now_ts`, run context), so a
//! skip drives exactly the code paths a real user hits — occurrences become
//! due, windows lapse, days roll over.
//!
//! Release builds compile all of this out: the offset reads as a constant
//! `0`, the setter refuses, and [`debug_tools_enabled`] reports false so the
//! frontend never surfaces the controls.

use std::sync::atomic::{AtomicI64, Ordering};

use serde::Serialize;
use tauri::State;

use crate::AppState;

#[cfg(debug_assertions)]
static OFFSET_SECS: AtomicI64 = AtomicI64::new(0);

/// The debug offset in seconds. Always `0` in release builds (const-folded).
pub fn offset_secs() -> i64 {
    #[cfg(debug_assertions)]
    {
        OFFSET_SECS.load(Ordering::Relaxed)
    }
    #[cfg(not(debug_assertions))]
    {
        0
    }
}

/// `dt` shifted by the debug offset (identity in release builds).
pub fn shift(dt: chrono::DateTime<chrono::Utc>) -> chrono::DateTime<chrono::Utc> {
    dt + chrono::Duration::seconds(offset_secs())
}

/// The engine's current time: wall clock + debug offset.
pub fn now() -> chrono::DateTime<chrono::Utc> {
    shift(chrono::Utc::now())
}

/// Set the offset (debug builds only). Returns the new offset.
pub fn set_offset(secs: i64) -> Result<i64, String> {
    #[cfg(debug_assertions)]
    {
        OFFSET_SECS.store(secs, Ordering::Relaxed);
        Ok(secs)
    }
    #[cfg(not(debug_assertions))]
    {
        let _ = secs;
        Err("debug time control is compiled out of release builds".into())
    }
}

/// Whether debug tooling is available (debug builds only).
#[tauri::command]
pub fn debug_tools_enabled() -> bool {
    cfg!(debug_assertions)
}

#[derive(Serialize)]
pub struct DebugTimeState {
    pub enabled: bool,
    pub offset_secs: i64,
    /// The engine's current time, RFC3339 (UTC).
    pub engine_now: String,
}

#[tauri::command]
pub fn debug_time_state() -> DebugTimeState {
    DebugTimeState {
        enabled: cfg!(debug_assertions),
        offset_secs: offset_secs(),
        engine_now: economy_fmt(now()),
    }
}

#[tauri::command]
pub fn debug_set_time_offset(offset_secs: i64) -> Result<DebugTimeState, String> {
    set_offset(offset_secs)?;
    Ok(debug_time_state())
}

/// Debug point grant/deduction. Same ledger path as every other points
/// action (`apply_points`), keyed to a distinct `debug:` source.
#[tauri::command]
pub async fn debug_grant_points(
    delta: i64,
    state: State<'_, AppState>,
) -> Result<DebugGrantResult, String> {
    if !cfg!(debug_assertions) {
        return Err("debug tooling is compiled out of release builds".into());
    }
    let state_dir = state.state_dir.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let econ = rusqlite::Connection::open(state_dir.join("economy.db"))
            .map_err(|e| e.to_string())?;
        let source = format!("debug:grant:{}", chrono::Utc::now().timestamp_micros());
        let reason = if delta >= 0 { "debug grant" } else { "debug deduct" };
        let balance = crate::economy::apply_points(&econ, delta, reason, &source)?
            .unwrap_or_else(|| crate::economy::balance(&econ).unwrap_or(0));
        Ok(DebugGrantResult { balance })
    })
    .await
    .map_err(|e| e.to_string())?
}

#[derive(Serialize)]
pub struct DebugGrantResult {
    pub balance: i64,
}

fn economy_fmt(dt: chrono::DateTime<chrono::Utc>) -> String {
    dt.to_rfc3339_opts(chrono::SecondsFormat::Secs, true)
}
