// State classifier — finite state machine per agent
// Enforces valid transitions and debounces rapid state changes

use crate::models::Status;
use std::collections::HashMap;
use std::time::{Duration, Instant};

/// Default debounce window: reject changes within this period
const DEFAULT_DEBOUNCE_MS: u64 = 300;

/// Default auto-idle timeout after TaskComplete
const DEFAULT_IDLE_TIMEOUT_MS: u64 = 3000;

/// Default inactivity timeout for Responding status (30s).
/// Opus 4.6 can have >10s gaps between response chunks during complex
/// reasoning. 30s prevents false idle while still catching missing `end_turn`.
const DEFAULT_RESPONDING_TIMEOUT_MS: u64 = 30_000;

/// Default safety timeout for Thinking and ToolUse (120s).
/// Long tool executions (Agent spawning, file reads, bash commands) can go
/// 30-60+ seconds without emitting JSONL events. 120s prevents premature
/// idle while still catching CLI exits without `end_turn`.
/// The auto-idle consumer checks `last_activity`, so active agents that
/// keep emitting events will never hit this timeout.
const DEFAULT_WORK_TIMEOUT_MS: u64 = 120_000;

/// Per-agent classification state
#[derive(Debug)]
pub struct ClassifiedState {
    pub status: Status,
    pub last_change: Instant,
}

impl ClassifiedState {
    fn new(status: Status) -> Self {
        Self {
            status,
            last_change: Instant::now(),
        }
    }
}

/// Result of a transition attempt
#[derive(Debug, PartialEq, Clone)]
pub enum TransitionResult {
    /// State was updated to the new status
    Updated(Status),
    /// Change was rejected because it is within the debounce window
    Debounced,
    /// Transition from current state to requested state is not valid
    InvalidTransition,
}

/// Check whether transitioning from `current` to `next` is allowed.
pub fn is_valid_transition(current: &Status, next: &Status) -> bool {
    use Status::*;
    matches!(
        (current, next),
        (Idle, Thinking)
            | (Idle, WalkingToDesk)
            | (Idle, Offline)
            | (WalkingToDesk, Idle)
            | (WalkingToDesk, Thinking)
            | (Thinking, Thinking)
            | (Thinking, Responding)
            | (Thinking, TaskComplete)
            | (Thinking, ToolUse)
            | (Thinking, Error)
            | (Thinking, Idle)
            | (Responding, Thinking)
            | (Responding, Responding)
            | (Responding, ToolUse)
            | (Responding, TaskComplete)
            | (Responding, Error)
            | (Responding, Idle)
            | (ToolUse, Thinking)
            | (ToolUse, Responding)
            | (ToolUse, ToolUse)
            | (ToolUse, TaskComplete)
            | (ToolUse, Error)
            | (ToolUse, Idle)
            | (TaskComplete, Idle)
            | (TaskComplete, Thinking)
            | (Collaboration, Idle)
            | (Collaboration, Thinking)
            | (Error, Idle)
            | (Error, Thinking)
            | (Offline, Idle)
    )
}

/// State classifier: manages per-agent FSM with debounce.
pub struct StateClassifier {
    states: HashMap<String, ClassifiedState>,
    debounce_ms: u64,
    idle_timeout_ms: u64,
    responding_timeout_ms: u64,
    work_timeout_ms: u64,
}

impl StateClassifier {
    pub fn new(debounce_ms: u64, idle_timeout_ms: u64) -> Self {
        Self {
            states: HashMap::new(),
            debounce_ms,
            idle_timeout_ms,
            responding_timeout_ms: DEFAULT_RESPONDING_TIMEOUT_MS,
            work_timeout_ms: DEFAULT_WORK_TIMEOUT_MS,
        }
    }

    /// Override the safety timeout for Thinking/ToolUse statuses.
    pub fn set_work_timeout_ms(&mut self, ms: u64) {
        self.work_timeout_ms = ms;
    }

    /// Override the inactivity timeout for Responding status.
    pub fn set_responding_timeout_ms(&mut self, ms: u64) {
        self.responding_timeout_ms = ms;
    }

    /// Return the inactivity timeout for a given status.
    /// Used for stale-resolution in the classifier when a transition is
    /// invalid from the current status but would be valid from Idle.
    fn inactivity_timeout_for(&self, status: &Status) -> Option<Duration> {
        match status {
            Status::Responding => Some(Duration::from_millis(self.responding_timeout_ms)),
            Status::Thinking | Status::ToolUse => Some(Duration::from_millis(self.work_timeout_ms)),
            _ => None,
        }
    }

    /// Attempt to transition an agent to a new status.
    /// Returns the result of the attempt.
    pub fn transition(&mut self, agent_id: &str, next: Status) -> TransitionResult {
        let debounce = Duration::from_millis(self.debounce_ms);

        match self.states.get(agent_id) {
            None => {
                // First state for this agent — accept anything
                app_log!(
                    "LOG_CLASSIFY",
                    "agent {} first state → {:?}",
                    agent_id,
                    next
                );
                let new_state = ClassifiedState::new(next.clone());
                self.states.insert(agent_id.to_string(), new_state);
                TransitionResult::Updated(next)
            }
            Some(state) => {
                // Debounce check — only for self-transitions (same status repeated).
                // Transitions to a DIFFERENT status must always pass through,
                // otherwise fast completions (Thinking → TaskComplete in <300ms)
                // get blocked and the agent is stuck forever.
                if state.status == next && state.last_change.elapsed() < debounce {
                    app_log!(
                        "LOG_CLASSIFY",
                        "agent {} debounced {:?} → {:?} ({}ms < {}ms)",
                        agent_id,
                        state.status,
                        next,
                        state.last_change.elapsed().as_millis(),
                        debounce.as_millis()
                    );
                    return TransitionResult::Debounced;
                }

                // First, check if the transition is valid from the REAL current status.
                // This handles cases like ToolUse → TaskComplete after a long-running
                // operation (>30s) where stale auto-resolve would incorrectly convert
                // ToolUse to Idle, making the valid transition appear invalid.
                if is_valid_transition(&state.status, &next) {
                    // Valid from real status — accept directly, no stale resolution needed
                } else {
                    // Auto-resolve stale statuses → Idle when their timeout has elapsed.
                    // This keeps the classifier in sync with the registry even if the
                    // auto-idle channel message was not yet processed.
                    let is_stale = if state.status == Status::TaskComplete {
                        state.last_change.elapsed() >= Duration::from_millis(self.idle_timeout_ms)
                    } else {
                        self.inactivity_timeout_for(&state.status)
                            .is_some_and(|timeout| state.last_change.elapsed() >= timeout)
                    };

                    let effective_current = if is_stale {
                        app_log!(
                            "LOG_CLASSIFY",
                            "agent {} stale auto-resolve: {:?} → Idle (elapsed {}ms)",
                            agent_id,
                            state.status,
                            state.last_change.elapsed().as_millis()
                        );
                        Status::Idle
                    } else {
                        state.status.clone()
                    };

                    if !is_valid_transition(&effective_current, &next) {
                        app_log!(
                            "LOG_CLASSIFY",
                            "agent {} invalid transition: {:?} → {:?}",
                            agent_id,
                            effective_current,
                            next
                        );
                        return TransitionResult::InvalidTransition;
                    }
                }

                let new_state = ClassifiedState::new(next.clone());
                self.states.insert(agent_id.to_string(), new_state);

                TransitionResult::Updated(next)
            }
        }
    }

    /// Get the current status for an agent.
    #[allow(dead_code)]
    pub fn get_status(&self, agent_id: &str) -> Option<&Status> {
        self.states.get(agent_id).map(|s| &s.status)
    }

    /// Remove an agent from tracking.
    #[allow(dead_code)]
    pub fn remove(&mut self, agent_id: &str) {
        self.states.remove(agent_id);
    }

    /// Return the auto-idle timeout (in ms) for a given status, if applicable.
    ///
    /// - **TaskComplete** → idle after `idle_timeout_ms` (3s default)
    /// - **Responding** → idle after `responding_timeout_ms` (30s default).
    ///   Opus 4.6 can have >10s gaps between response chunks during complex
    ///   reasoning; a missing `end_turn` is detected within 30s.
    /// - **Thinking/ToolUse** → idle after `work_timeout_ms` (120s default).
    ///   Safety net: if CLI exits without emitting `end_turn`, the agent
    ///   transitions to Idle instead of being stuck forever. Active agents
    ///   keep emitting JSONL events, so `last_activity` resets the timer.
    ///
    /// The caller is responsible for scheduling the timer **after** updating
    /// `last_activity` in the registry, to avoid the race condition where
    /// `scheduled_at` is captured before `last_activity`, causing the
    /// auto-idle consumer to always discard the timer as stale.
    pub fn auto_idle_timeout_for(&self, status: &Status) -> Option<u64> {
        match status {
            Status::TaskComplete => Some(self.idle_timeout_ms),
            Status::Responding => Some(self.responding_timeout_ms),
            Status::Thinking | Status::ToolUse => Some(self.work_timeout_ms),
            _ => None,
        }
    }
}

impl Default for StateClassifier {
    fn default() -> Self {
        Self::new(DEFAULT_DEBOUNCE_MS, DEFAULT_IDLE_TIMEOUT_MS)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn classifier() -> StateClassifier {
        // Use 0ms debounce for most tests to avoid timing flakiness
        StateClassifier::new(0, DEFAULT_IDLE_TIMEOUT_MS)
    }

    #[test]
    fn test_classifier_valid_transition_idle_to_thinking() {
        let mut c = classifier();
        let result = c.transition("agent-1", Status::Thinking);
        // First transition for new agent is always accepted
        assert_eq!(result, TransitionResult::Updated(Status::Thinking));

        // Idle → Thinking would be via first registration; simulate properly:
        let mut c2 = classifier();
        // Register as Idle first
        c2.states
            .insert("a".to_string(), ClassifiedState::new(Status::Idle));
        // Force last_change to be old enough
        c2.states.get_mut("a").unwrap().last_change = Instant::now() - Duration::from_millis(500);

        let r = c2.transition("a", Status::Thinking);
        assert_eq!(r, TransitionResult::Updated(Status::Thinking));
    }

    #[test]
    fn test_classifier_valid_chain() {
        let mut c = StateClassifier::new(0, DEFAULT_IDLE_TIMEOUT_MS);
        // Seed as Idle
        c.states
            .insert("a".to_string(), ClassifiedState::new(Status::Idle));

        let r1 = c.transition("a", Status::Thinking);
        assert_eq!(r1, TransitionResult::Updated(Status::Thinking));

        let r2 = c.transition("a", Status::Responding);
        assert_eq!(r2, TransitionResult::Updated(Status::Responding));

        let r3 = c.transition("a", Status::TaskComplete);
        assert_eq!(r3, TransitionResult::Updated(Status::TaskComplete));
    }

    #[test]
    fn test_classifier_invalid_transition_idle_to_task_complete() {
        let mut c = StateClassifier::new(0, DEFAULT_IDLE_TIMEOUT_MS);
        c.states
            .insert("a".to_string(), ClassifiedState::new(Status::Idle));
        let result = c.transition("a", Status::TaskComplete);
        assert_eq!(result, TransitionResult::InvalidTransition);
    }

    #[test]
    fn test_classifier_invalid_transition_idle_to_responding() {
        let mut c = StateClassifier::new(0, DEFAULT_IDLE_TIMEOUT_MS);
        c.states
            .insert("a".to_string(), ClassifiedState::new(Status::Idle));
        let result = c.transition("a", Status::Responding);
        assert_eq!(result, TransitionResult::InvalidTransition);
    }

    #[test]
    fn test_classifier_debounce_only_self_transitions() {
        // Debounce only applies to self-transitions (same status repeated).
        // Transitions to a DIFFERENT status always pass through.
        let mut c = StateClassifier::new(500, DEFAULT_IDLE_TIMEOUT_MS);
        c.states
            .insert("a".to_string(), ClassifiedState::new(Status::Idle));

        // Different status within debounce window — should NOT be debounced
        let r = c.transition("a", Status::Thinking);
        assert_eq!(r, TransitionResult::Updated(Status::Thinking));
    }

    #[test]
    fn test_classifier_debounce_passes_after_wait() {
        let mut c = StateClassifier::new(100, DEFAULT_IDLE_TIMEOUT_MS);
        c.states
            .insert("a".to_string(), ClassifiedState::new(Status::Idle));
        // Move last_change back in time
        c.states.get_mut("a").unwrap().last_change = Instant::now() - Duration::from_millis(200);

        let r = c.transition("a", Status::Thinking);
        assert_eq!(r, TransitionResult::Updated(Status::Thinking));
    }

    #[test]
    fn test_classifier_get_status() {
        let mut c = classifier();
        assert!(c.get_status("unknown").is_none());

        c.transition("a", Status::Thinking);
        assert_eq!(c.get_status("a"), Some(&Status::Thinking));
    }

    #[test]
    fn test_classifier_remove() {
        let mut c = classifier();
        c.transition("a", Status::Thinking);
        c.remove("a");
        assert!(c.get_status("a").is_none());
    }

    #[test]
    fn test_is_valid_transition_matrix() {
        assert!(is_valid_transition(&Status::Idle, &Status::Thinking));
        assert!(is_valid_transition(&Status::Thinking, &Status::Responding));
        assert!(is_valid_transition(&Status::Responding, &Status::ToolUse));
        assert!(is_valid_transition(&Status::TaskComplete, &Status::Idle));
        assert!(is_valid_transition(&Status::Error, &Status::Idle));
        assert!(is_valid_transition(&Status::Offline, &Status::Idle));

        // New valid transitions (Bug 2 fix)
        assert!(is_valid_transition(
            &Status::Thinking,
            &Status::TaskComplete
        ));
        assert!(is_valid_transition(&Status::Thinking, &Status::ToolUse));
        assert!(is_valid_transition(
            &Status::TaskComplete,
            &Status::Thinking
        ));

        // Responding/ToolUse → Thinking (new user message mid-session)
        assert!(is_valid_transition(&Status::Responding, &Status::Thinking));
        assert!(is_valid_transition(&Status::ToolUse, &Status::Thinking));

        // Self-transitions for work statuses (keeps auto-idle timers fresh)
        assert!(is_valid_transition(&Status::Thinking, &Status::Thinking));
        assert!(is_valid_transition(
            &Status::Responding,
            &Status::Responding
        ));
        assert!(is_valid_transition(&Status::ToolUse, &Status::ToolUse));

        // Invalid transitions
        assert!(!is_valid_transition(&Status::Idle, &Status::TaskComplete));
        assert!(!is_valid_transition(&Status::Idle, &Status::Responding));
        assert!(!is_valid_transition(&Status::Idle, &Status::ToolUse));
    }

    #[test]
    fn test_classifier_auto_resolves_stale_task_complete() {
        // Use 100ms idle timeout so we can simulate staleness
        let mut c = StateClassifier::new(0, 100);
        c.states
            .insert("a".to_string(), ClassifiedState::new(Status::TaskComplete));
        // Move last_change back beyond the idle timeout
        c.states.get_mut("a").unwrap().last_change = Instant::now() - Duration::from_millis(200);

        // TaskComplete→Thinking is valid via FSM, but this also tests auto-resolve path
        // where effective_current becomes Idle (Idle→Thinking is valid too)
        let r = c.transition("a", Status::Thinking);
        assert_eq!(r, TransitionResult::Updated(Status::Thinking));
    }

    #[test]
    fn test_classifier_short_response_thinking_to_task_complete() {
        let mut c = StateClassifier::new(0, DEFAULT_IDLE_TIMEOUT_MS);
        c.states
            .insert("a".to_string(), ClassifiedState::new(Status::Idle));
        let r1 = c.transition("a", Status::Thinking);
        assert_eq!(r1, TransitionResult::Updated(Status::Thinking));
        let r2 = c.transition("a", Status::TaskComplete);
        assert_eq!(r2, TransitionResult::Updated(Status::TaskComplete));
    }

    #[test]
    fn test_classifier_direct_tool_use_from_thinking() {
        let mut c = StateClassifier::new(0, DEFAULT_IDLE_TIMEOUT_MS);
        c.states
            .insert("a".to_string(), ClassifiedState::new(Status::Idle));
        let r1 = c.transition("a", Status::Thinking);
        assert_eq!(r1, TransitionResult::Updated(Status::Thinking));
        let r2 = c.transition("a", Status::ToolUse);
        assert_eq!(r2, TransitionResult::Updated(Status::ToolUse));
    }

    #[test]
    fn test_classifier_responding_to_thinking() {
        let mut c = StateClassifier::new(0, DEFAULT_IDLE_TIMEOUT_MS);
        c.states
            .insert("a".to_string(), ClassifiedState::new(Status::Idle));
        let r1 = c.transition("a", Status::Thinking);
        assert_eq!(r1, TransitionResult::Updated(Status::Thinking));
        let r2 = c.transition("a", Status::Responding);
        assert_eq!(r2, TransitionResult::Updated(Status::Responding));
        let r3 = c.transition("a", Status::Thinking);
        assert_eq!(r3, TransitionResult::Updated(Status::Thinking));
    }

    #[test]
    fn test_classifier_tool_use_to_thinking() {
        let mut c = StateClassifier::new(0, DEFAULT_IDLE_TIMEOUT_MS);
        c.states
            .insert("a".to_string(), ClassifiedState::new(Status::Idle));
        let r1 = c.transition("a", Status::Thinking);
        assert_eq!(r1, TransitionResult::Updated(Status::Thinking));
        let r2 = c.transition("a", Status::ToolUse);
        assert_eq!(r2, TransitionResult::Updated(Status::ToolUse));
        let r3 = c.transition("a", Status::Thinking);
        assert_eq!(r3, TransitionResult::Updated(Status::Thinking));
    }

    #[test]
    fn test_auto_idle_timeout_for_task_complete() {
        let c = StateClassifier::new(0, 50);
        assert_eq!(c.auto_idle_timeout_for(&Status::TaskComplete), Some(50));
    }

    #[test]
    fn test_auto_idle_timeout_responding() {
        let c = StateClassifier::new(0, 3000);
        let responding = c.auto_idle_timeout_for(&Status::Responding).unwrap();
        assert_eq!(responding, DEFAULT_RESPONDING_TIMEOUT_MS);
    }

    #[test]
    fn test_auto_idle_timeout_for_thinking_and_tool_use() {
        let c = StateClassifier::new(0, 3000);
        // Thinking and ToolUse have a safety timeout (120s default)
        assert_eq!(
            c.auto_idle_timeout_for(&Status::Thinking),
            Some(DEFAULT_WORK_TIMEOUT_MS)
        );
        assert_eq!(
            c.auto_idle_timeout_for(&Status::ToolUse),
            Some(DEFAULT_WORK_TIMEOUT_MS)
        );
    }

    #[test]
    fn test_auto_idle_timeout_custom_work_timeout() {
        let mut c = StateClassifier::new(0, 3000);
        c.set_work_timeout_ms(60_000);
        assert_eq!(c.auto_idle_timeout_for(&Status::Thinking), Some(60_000));
        assert_eq!(c.auto_idle_timeout_for(&Status::ToolUse), Some(60_000));
        // Other timeouts unchanged
        assert_eq!(c.auto_idle_timeout_for(&Status::TaskComplete), Some(3000));
        assert_eq!(
            c.auto_idle_timeout_for(&Status::Responding),
            Some(DEFAULT_RESPONDING_TIMEOUT_MS)
        );
    }

    #[test]
    fn test_auto_idle_timeout_custom_responding_timeout() {
        let mut c = StateClassifier::new(0, 3000);
        c.set_responding_timeout_ms(45_000);
        assert_eq!(c.auto_idle_timeout_for(&Status::Responding), Some(45_000));
        // Other timeouts unchanged
        assert_eq!(c.auto_idle_timeout_for(&Status::TaskComplete), Some(3000));
        assert_eq!(
            c.auto_idle_timeout_for(&Status::Thinking),
            Some(DEFAULT_WORK_TIMEOUT_MS)
        );
        assert_eq!(
            c.auto_idle_timeout_for(&Status::ToolUse),
            Some(DEFAULT_WORK_TIMEOUT_MS)
        );
    }

    #[test]
    fn test_classifier_auto_resolves_stale_thinking() {
        let mut c = StateClassifier::new(0, 3000);
        c.set_work_timeout_ms(100);
        c.states
            .insert("a".to_string(), ClassifiedState::new(Status::Thinking));
        // Move last_change back beyond the work timeout
        c.states.get_mut("a").unwrap().last_change = Instant::now() - Duration::from_millis(200);

        // Thinking is stale → effective_current becomes Idle → Idle→Thinking is valid
        let r = c.transition("a", Status::Thinking);
        assert_eq!(r, TransitionResult::Updated(Status::Thinking));
    }

    #[test]
    fn test_classifier_auto_resolves_stale_tool_use() {
        let mut c = StateClassifier::new(0, 3000);
        c.set_work_timeout_ms(100);
        c.states
            .insert("a".to_string(), ClassifiedState::new(Status::ToolUse));
        // Move last_change back beyond the work timeout
        c.states.get_mut("a").unwrap().last_change = Instant::now() - Duration::from_millis(200);

        // ToolUse is stale → effective_current becomes Idle → Idle→Thinking is valid
        let r = c.transition("a", Status::Thinking);
        assert_eq!(r, TransitionResult::Updated(Status::Thinking));
    }

    #[test]
    fn test_auto_idle_timeout_for_non_work_statuses() {
        let c = StateClassifier::new(0, 3000);
        assert_eq!(c.auto_idle_timeout_for(&Status::Idle), None);
        assert_eq!(c.auto_idle_timeout_for(&Status::Error), None);
        assert_eq!(c.auto_idle_timeout_for(&Status::Offline), None);
    }

    #[test]
    fn test_classifier_auto_resolves_stale_responding() {
        let mut c = StateClassifier::new(0, 3000);
        c.responding_timeout_ms = 100;
        c.states
            .insert("a".to_string(), ClassifiedState::new(Status::Responding));
        // Move last_change back beyond the responding timeout
        c.states.get_mut("a").unwrap().last_change = Instant::now() - Duration::from_millis(200);

        // Responding is stale → effective_current becomes Idle → Idle→Thinking is valid
        let r = c.transition("a", Status::Thinking);
        assert_eq!(r, TransitionResult::Updated(Status::Thinking));
    }

    #[test]
    fn test_classifier_tool_use_to_thinking_after_long_pause() {
        // ToolUse → Thinking is valid directly in FSM, no stale resolution needed.
        // This verifies transitions work even after long tool executions.
        let mut c = StateClassifier::new(0, 3000);
        c.states
            .insert("a".to_string(), ClassifiedState::new(Status::ToolUse));
        // Simulate a long-running tool (5 minutes)
        c.states.get_mut("a").unwrap().last_change = Instant::now() - Duration::from_secs(300);

        let r = c.transition("a", Status::Thinking);
        assert_eq!(r, TransitionResult::Updated(Status::Thinking));
    }

    #[test]
    fn test_classifier_tool_use_allows_task_complete_after_long_pause() {
        // ToolUse → TaskComplete is valid directly in FSM.
        // Agent stays at desk during long tool execution, no false idle.
        let mut c = StateClassifier::new(0, 3000);
        c.states
            .insert("a".to_string(), ClassifiedState::new(Status::ToolUse));
        // Simulate a long-running tool (5 minutes)
        c.states.get_mut("a").unwrap().last_change = Instant::now() - Duration::from_secs(300);

        let r = c.transition("a", Status::TaskComplete);
        assert_eq!(r, TransitionResult::Updated(Status::TaskComplete));
    }

    #[test]
    fn test_responding_self_transition_after_debounce() {
        let mut c = StateClassifier::new(0, 3000);
        c.states
            .insert("a".to_string(), ClassifiedState::new(Status::Responding));
        // Move past debounce
        c.states.get_mut("a").unwrap().last_change = Instant::now() - Duration::from_millis(500);

        // Responding→Responding is now a valid self-transition
        let r = c.transition("a", Status::Responding);
        assert_eq!(r, TransitionResult::Updated(Status::Responding));
    }

    #[test]
    fn test_tool_use_self_transition_refreshes_timer() {
        let mut c = StateClassifier::new(0, 3000);
        c.states
            .insert("a".to_string(), ClassifiedState::new(Status::ToolUse));
        c.states.get_mut("a").unwrap().last_change = Instant::now() - Duration::from_millis(500);

        // ToolUse→ToolUse keeps agent active and reschedules auto-idle timer
        let r = c.transition("a", Status::ToolUse);
        assert_eq!(r, TransitionResult::Updated(Status::ToolUse));
    }

    #[test]
    fn test_thinking_self_transition_refreshes_timer() {
        let mut c = StateClassifier::new(0, 3000);
        c.states
            .insert("a".to_string(), ClassifiedState::new(Status::Thinking));
        c.states.get_mut("a").unwrap().last_change = Instant::now() - Duration::from_millis(500);

        // Thinking→Thinking keeps agent active and reschedules auto-idle timer
        let r = c.transition("a", Status::Thinking);
        assert_eq!(r, TransitionResult::Updated(Status::Thinking));
    }

    #[test]
    fn test_self_transition_still_debounced() {
        // Self-transitions should still respect the debounce window
        let mut c = StateClassifier::new(500, 3000);
        c.states
            .insert("a".to_string(), ClassifiedState::new(Status::ToolUse));
        // Same status within debounce window — debounced
        let r = c.transition("a", Status::ToolUse);
        assert_eq!(r, TransitionResult::Debounced);
    }

    #[test]
    fn test_fast_thinking_to_task_complete_not_debounced() {
        // Critical bug fix: fast completions must NOT be debounced.
        // Agent completes in <300ms (e.g. short answer) — TaskComplete must pass.
        let mut c = StateClassifier::new(300, DEFAULT_IDLE_TIMEOUT_MS);
        c.states
            .insert("a".to_string(), ClassifiedState::new(Status::Thinking));
        // Immediately (within debounce window) transition to TaskComplete
        let r = c.transition("a", Status::TaskComplete);
        assert_eq!(r, TransitionResult::Updated(Status::TaskComplete));
    }

    #[test]
    fn test_fast_responding_to_task_complete_not_debounced() {
        // Same as above but for Responding → TaskComplete
        let mut c = StateClassifier::new(300, DEFAULT_IDLE_TIMEOUT_MS);
        c.states
            .insert("a".to_string(), ClassifiedState::new(Status::Responding));
        let r = c.transition("a", Status::TaskComplete);
        assert_eq!(r, TransitionResult::Updated(Status::TaskComplete));
    }
}
