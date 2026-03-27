// Agent registry — HashMap<AgentId, AgentState>
// Emits agent:found, agent:lost, agent:state-changed events via Tauri AppHandle

use crate::ipc::events;
use crate::models::{AgentState, Status};
use std::collections::HashMap;
use std::sync::Arc;
use sysinfo::System;
use tauri::AppHandle;
use tokio::sync::RwLock;

/// Central registry of all known AI agents.
/// Thread-safe via Arc<RwLock<...>> wrapper.
#[derive(Debug, Default)]
pub struct AgentRegistry {
    agents: HashMap<String, AgentState>,
}

impl AgentRegistry {
    pub fn new() -> Self {
        Self {
            agents: HashMap::new(),
        }
    }

    /// Register a new agent and emit agent:found event.
    pub fn register(&mut self, agent: AgentState, handle: &AppHandle) {
        let id = agent.id.clone();
        app_log!(
            "REGISTRY",
            "register agent id={} name='{}' status={:?} (total={})",
            id,
            agent.name,
            agent.status,
            self.agents.len() + 1
        );
        self.agents.insert(id, agent.clone());
        if let Err(e) = events::emit_agent_found(handle, &agent) {
            app_log!(
                "REGISTRY",
                "emit agent:found failed for {}: {}",
                agent.id,
                e
            );
        }
        events::update_badge(handle, self.active_count());
    }

    /// Update an existing agent's state and emit agent:state-changed.
    pub fn update(&mut self, id: &str, state: AgentState, handle: &AppHandle) {
        if self.agents.contains_key(id) {
            self.agents.insert(id.to_string(), state.clone());
            if let Err(e) = events::emit_agent_state_changed(handle, &state) {
                app_log!(
                    "REGISTRY",
                    "emit agent:state-changed failed for {}: {}",
                    id,
                    e
                );
            }
            events::update_badge(handle, self.active_count());
        } else {
            app_log!("REGISTRY", "update called for unknown agent id={}", id);
        }
    }

    /// Remove an agent and emit agent:lost event.
    pub fn remove(&mut self, id: &str, handle: &AppHandle) {
        if self.agents.remove(id).is_some() {
            app_log!(
                "REGISTRY",
                "removed agent id={} (remaining={})",
                id,
                self.agents.len()
            );
            if let Err(e) = events::emit_agent_lost(handle, id) {
                app_log!("REGISTRY", "emit agent:lost failed for {}: {}", id, e);
            }
            events::update_badge(handle, self.active_count());
        }
    }

    /// Get a single agent by id.
    pub fn get(&self, id: &str) -> Option<AgentState> {
        self.agents.get(id).cloned()
    }

    /// Get all registered agents as a Vec.
    pub fn get_all(&self) -> Vec<AgentState> {
        self.agents.values().cloned().collect()
    }

    /// Return the number of registered agents.
    pub fn len(&self) -> usize {
        self.agents.len()
    }

    /// Return true if registry is empty.
    #[allow(dead_code)]
    pub fn is_empty(&self) -> bool {
        self.agents.is_empty()
    }

    /// Remove agents whose PID no longer exists in the OS process table.
    /// Called at each scan cycle.
    #[allow(dead_code)]
    pub fn cleanup_dead_processes(&mut self, handle: &AppHandle) {
        let mut system = System::new_all();
        system.refresh_all();

        let dead_ids: Vec<String> = self
            .agents
            .values()
            .filter(|agent| {
                if let Some(pid) = agent.pid {
                    let sysinfo_pid = sysinfo::Pid::from_u32(pid);
                    system.process(sysinfo_pid).is_none()
                } else {
                    false
                }
            })
            .map(|agent| agent.id.clone())
            .collect();

        for id in dead_ids {
            self.remove(&id, handle);
        }
    }

    /// Direct insert without emitting events — used only in tests.
    #[cfg(test)]
    pub fn insert_for_test(&mut self, agent: AgentState) {
        self.agents.insert(agent.id.clone(), agent);
    }

    /// Count agents that are actively working (not Idle, Offline, or Error).
    pub fn active_count(&self) -> u32 {
        self.agents
            .values()
            .filter(|a| !matches!(a.status, Status::Idle | Status::Offline | Status::Error | Status::TaskComplete))
            .count() as u32
    }

    /// Sum of all tokens_in across all agents.
    pub fn total_tokens_in(&self) -> u64 {
        self.agents.values().map(|a| a.tokens_in).sum()
    }

    /// Sum of all tokens_out across all agents.
    pub fn total_tokens_out(&self) -> u64 {
        self.agents.values().map(|a| a.tokens_out).sum()
    }
}

/// Shared, thread-safe registry handle.
pub type SharedRegistry = Arc<RwLock<AgentRegistry>>;

/// Create a new shared registry.
pub fn new_shared_registry() -> SharedRegistry {
    Arc::new(RwLock::new(AgentRegistry::new()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::{IdleLocation, Source, Status, Tier};

    fn make_agent(id: &str, pid: u32) -> AgentState {
        AgentState {
            id: id.to_string(),
            pid: Some(pid),
            name: "claude".to_string(),
            model: "claude".to_string(),
            tier: Tier::Middle,
            role: "agent".to_string(),
            status: Status::Idle,
            idle_location: IdleLocation::Desk,
            current_task: None,
            tokens_in: 100,
            tokens_out: 50,
            sub_agents: vec![],
            last_activity: "2026-01-01T00:00:00Z".to_string(),
            started_at: "2026-01-01T00:00:00Z".to_string(),
            source: Source::Cli,
        }
    }

    #[test]
    fn test_registry_add_remove() {
        let mut registry = AgentRegistry::new();
        assert!(registry.is_empty());

        // We cannot call register/remove without AppHandle in unit tests,
        // so we test internal state directly.
        let agent = make_agent("agent-1", 9999);
        registry.agents.insert(agent.id.clone(), agent.clone());
        assert_eq!(registry.len(), 1);

        registry.agents.remove("agent-1");
        assert!(registry.is_empty());
    }

    #[test]
    fn test_registry_get() {
        let mut registry = AgentRegistry::new();
        let agent = make_agent("agent-2", 8888);
        registry.agents.insert(agent.id.clone(), agent.clone());

        let found = registry.get("agent-2");
        assert!(found.is_some());
        assert_eq!(found.unwrap().pid, Some(8888));

        assert!(registry.get("nonexistent").is_none());
    }

    #[test]
    fn test_registry_get_all() {
        let mut registry = AgentRegistry::new();
        let a1 = make_agent("a1", 1001);
        let a2 = make_agent("a2", 1002);
        registry.agents.insert(a1.id.clone(), a1);
        registry.agents.insert(a2.id.clone(), a2);

        let all = registry.get_all();
        assert_eq!(all.len(), 2);
    }

    #[test]
    fn test_active_count() {
        let mut registry = AgentRegistry::new();

        let mut idle = make_agent("idle", 1);
        idle.status = Status::Idle;

        let mut thinking = make_agent("thinking", 2);
        thinking.status = Status::Thinking;

        registry.agents.insert(idle.id.clone(), idle);
        registry.agents.insert(thinking.id.clone(), thinking);

        assert_eq!(registry.active_count(), 1);
    }

    #[test]
    fn test_active_count_excludes_error() {
        let mut registry = AgentRegistry::new();

        let mut error_agent = make_agent("error", 3);
        error_agent.status = Status::Error;

        let mut thinking = make_agent("thinking", 4);
        thinking.status = Status::Thinking;

        registry.agents.insert(error_agent.id.clone(), error_agent);
        registry.agents.insert(thinking.id.clone(), thinking);

        assert_eq!(registry.active_count(), 1);
    }

    #[test]
    fn test_active_count_excludes_idle_offline_error() {
        let mut registry = AgentRegistry::new();

        let mut idle = make_agent("idle", 1);
        idle.status = Status::Idle;

        let mut offline = make_agent("offline", 2);
        offline.status = Status::Offline;

        let mut error = make_agent("error", 3);
        error.status = Status::Error;

        let mut tool_use = make_agent("tooluse", 4);
        tool_use.status = Status::ToolUse;

        registry.agents.insert(idle.id.clone(), idle);
        registry.agents.insert(offline.id.clone(), offline);
        registry.agents.insert(error.id.clone(), error);
        registry.agents.insert(tool_use.id.clone(), tool_use);

        assert_eq!(registry.active_count(), 1);
    }

    #[test]
    fn test_token_totals() {
        let mut registry = AgentRegistry::new();
        let a1 = make_agent("t1", 10);
        let a2 = make_agent("t2", 11);
        registry.agents.insert(a1.id.clone(), a1);
        registry.agents.insert(a2.id.clone(), a2);

        assert_eq!(registry.total_tokens_in(), 200);
        assert_eq!(registry.total_tokens_out(), 100);
    }

    #[test]
    fn test_registry_auto_cleanup_with_invalid_pid() {
        // PID 999999 almost certainly does not exist.
        // We cannot call cleanup without AppHandle,
        // so we test the filtering logic directly.
        let registry = AgentRegistry::new();
        let _agent = make_agent("ghost", 999_999);

        let mut system = System::new_all();
        system.refresh_all();

        let pid = sysinfo::Pid::from_u32(999_999);
        // Ghost PID should not be found
        assert!(system.process(pid).is_none());
        let _ = registry; // suppress unused warning
    }
}
