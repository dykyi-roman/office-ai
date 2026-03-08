// Tauri event emitters
// Helper functions to emit typed events to the frontend

use crate::error::AppError;
use crate::models::{
    event_names, AgentFoundPayload, AgentLostPayload, AgentState, AgentStateChangedPayload,
    OfficeLayout, OfficeLayoutChangedPayload,
};
use tauri::{AppHandle, Emitter, Manager};

/// Emit agent:found event with the full AgentState payload.
pub fn emit_agent_found(handle: &AppHandle, agent: &AgentState) -> Result<(), AppError> {
    let payload = AgentFoundPayload {
        agent: agent.clone(),
    };
    handle
        .emit(event_names::AGENT_FOUND, payload)
        .map_err(|e| AppError::TauriError(e.to_string()))
}

/// Emit agent:lost event with just the agent id.
pub fn emit_agent_lost(handle: &AppHandle, id: &str) -> Result<(), AppError> {
    let payload = AgentLostPayload { id: id.to_string() };
    handle
        .emit(event_names::AGENT_LOST, payload)
        .map_err(|e| AppError::TauriError(e.to_string()))
}

/// Emit agent:state-changed event with updated AgentState.
pub fn emit_agent_state_changed(handle: &AppHandle, agent: &AgentState) -> Result<(), AppError> {
    let payload = AgentStateChangedPayload {
        agent: agent.clone(),
    };
    handle
        .emit(event_names::AGENT_STATE_CHANGED, payload)
        .map_err(|e| AppError::TauriError(e.to_string()))
}

/// Emit office:layout-changed event with full OfficeLayout payload.
#[allow(dead_code)]
pub fn emit_office_layout_changed(
    handle: &AppHandle,
    layout: &OfficeLayout,
) -> Result<(), AppError> {
    let payload = OfficeLayoutChangedPayload {
        layout: layout.clone(),
    };
    handle
        .emit(event_names::OFFICE_LAYOUT_CHANGED, payload)
        .map_err(|e| AppError::TauriError(e.to_string()))
}

/// Update the app dock/taskbar badge with active agent count.
/// Passes None when count is 0 to remove the badge.
/// Works on macOS and Linux (Unity/KDE). No-op on unsupported platforms.
pub fn update_badge(handle: &AppHandle, active_count: u32) {
    if let Some(window) = handle.get_webview_window("main") {
        let count = badge_count(active_count);
        if let Err(e) = window.set_badge_count(count) {
            app_log!("BADGE", "set_badge_count failed: {}", e);
        }
    }
}

/// Convert active agent count to badge value: 0 → None (remove badge), N → Some(N).
fn badge_count(active_count: u32) -> Option<i64> {
    if active_count == 0 {
        None
    } else {
        Some(active_count as i64)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::{
        AgentFoundPayload, AgentLostPayload, AgentState, IdleLocation, Source, Status, Tier,
    };

    fn make_agent() -> AgentState {
        AgentState {
            id: "test-001".to_string(),
            pid: Some(42),
            name: "claude".to_string(),
            model: "claude-opus-4".to_string(),
            tier: Tier::Expert,
            role: "agent".to_string(),
            status: Status::Thinking,
            idle_location: IdleLocation::Desk,
            current_task: Some("Fix the bug".to_string()),
            tokens_in: 500,
            tokens_out: 200,
            sub_agents: vec![],
            last_activity: "2026-01-01T00:00:00Z".to_string(),
            source: Source::Cli,
        }
    }

    #[test]
    fn test_emit_agent_found_payload_structure() {
        let agent = make_agent();
        let payload = AgentFoundPayload {
            agent: agent.clone(),
        };
        let json = serde_json::to_string(&payload).unwrap();
        // Verify camelCase serialization
        assert!(json.contains("\"agent\""));
        assert!(json.contains("\"test-001\""));
        assert!(json.contains("\"claude-opus-4\""));
    }

    #[test]
    fn test_emit_agent_lost_payload_structure() {
        let payload = AgentLostPayload {
            id: "test-001".to_string(),
        };
        let json = serde_json::to_string(&payload).unwrap();
        assert!(json.contains("\"id\""));
        assert!(json.contains("\"test-001\""));
    }

    #[test]
    fn test_agent_state_serializes_camel_case() {
        let agent = make_agent();
        let json = serde_json::to_string(&agent).unwrap();
        // Check camelCase fields
        assert!(json.contains("\"tokensIn\""));
        assert!(json.contains("\"tokensOut\""));
        assert!(json.contains("\"lastActivity\""));
        assert!(json.contains("\"currentTask\""));
        assert!(json.contains("\"idleLocation\""));
    }

    #[test]
    fn test_badge_count_zero_returns_none() {
        assert_eq!(super::badge_count(0), None);
    }

    #[test]
    fn test_badge_count_nonzero_returns_some() {
        assert_eq!(super::badge_count(1), Some(1));
        assert_eq!(super::badge_count(5), Some(5));
        assert_eq!(super::badge_count(20), Some(20));
    }

    #[test]
    fn test_event_name_constants() {
        assert_eq!(event_names::AGENT_FOUND, "agent:found");
        assert_eq!(event_names::AGENT_LOST, "agent:lost");
        assert_eq!(event_names::AGENT_STATE_CHANGED, "agent:state-changed");
        assert_eq!(event_names::OFFICE_LAYOUT_CHANGED, "office:layout-changed");
    }
}
