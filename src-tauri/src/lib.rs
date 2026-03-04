// OfficeAI — Tauri v2 backend entry point
// Initializes all modules and wires them into the Tauri builder

#[macro_use]
mod logger;
mod discovery;
mod error;
mod interceptor;
mod ipc;
mod models;

use discovery::agent_registry::new_shared_registry;
use discovery::log_watcher::{run_log_watcher, RawLogLine};
use discovery::process_scanner::{run_scanner, ScannerEvent};
use interceptor::claude_code_parser::ClaudeCodeParser;
use interceptor::parser_registry::ParserRegistry;
use interceptor::state_classifier::{StateClassifier, TransitionResult};
use ipc::commands::{
    generate_bug_report, get_agent, get_all_agents, get_config, get_stats, set_config, AppState,
};
use models::AppConfig;
use std::sync::Arc;
use tokio::sync::{mpsc, RwLock};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    logger::init();
    app_log!("INIT", "OfficeAI starting");

    // Load config from disk or use defaults
    let config = load_config_or_default();
    app_log!(
        "INIT",
        "config loaded: scan_interval={}ms, max_agents={}, idle_timeout={}ms, debounce={}ms, work_timeout={}ms, responding_timeout={}ms",
        config.scan_interval_ms,
        config.max_agents,
        config.idle_timeout_ms,
        config.state_debounce_ms,
        config.work_timeout_ms,
        config.responding_timeout_ms
    );
    let config = Arc::new(RwLock::new(config));

    // Initialize the shared agent registry
    let registry = new_shared_registry();

    let app_state = AppState::new(Arc::clone(&registry), Arc::clone(&config));

    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(app_state)
        .invoke_handler(tauri::generate_handler![
            get_all_agents,
            get_agent,
            get_config,
            set_config,
            get_stats,
            generate_bug_report,
        ])
        .setup(move |app| {
            // Set window icon from embedded PNG (ensures visibility in dev mode)
            {
                use tauri::Manager;
                if let Some(main_window) = app.get_webview_window("main") {
                    let icon_bytes = include_bytes!("../icons/128x128.png");
                    if let Ok(icon) = tauri::image::Image::from_bytes(icon_bytes) {
                        let _ = main_window.set_icon(icon);
                    }
                }
            }

            // Clear any stale badge from a previous session
            ipc::events::update_badge(app.handle(), 0);

            let handle = app.handle().clone();
            let scan_config = Arc::clone(&config);
            let scan_registry = Arc::clone(&registry);

            // Channel for process scanner → registry
            let (scanner_tx, mut scanner_rx) = mpsc::channel::<ScannerEvent>(128);

            // Channel for log watcher → interceptor
            let (log_tx, mut log_rx) = mpsc::channel::<RawLogLine>(512);

            // Channel for auto-idle transitions from state classifier.
            // Carries (agent_id, Status::Idle, scheduled_at) so the consumer can
            // discard stale timers when the agent received new events after scheduling.
            let (idle_tx, mut idle_rx) =
                mpsc::channel::<(String, models::Status, std::time::Instant)>(64);

            let registry_for_scanner = Arc::clone(&scan_registry);
            let handle_for_scanner = handle.clone();

            // Spawn process scanner task
            tauri::async_runtime::spawn(async move {
                run_scanner(scan_config, scanner_tx).await;
            });

            // Build parser registry — register all known parsers
            let mut parser_registry = ParserRegistry::new();
            let claude_idx = parser_registry.register_parser(Arc::new(ClaudeCodeParser));
            // Bind Claude Code's default log directory
            if let Some(home) = dirs::home_dir() {
                let claude_projects = home.join(".claude").join("projects");
                parser_registry.bind_directory(claude_projects, claude_idx);
            }
            let parser_registry = Arc::new(parser_registry);

            // Spawn log watcher task
            let log_config = Arc::clone(&config);
            tauri::async_runtime::spawn(async move {
                let (log_roots, custom_paths) = {
                    let cfg = log_config.read().await;
                    (cfg.log_roots.clone(), cfg.custom_log_paths.clone())
                };
                if let Err(e) = run_log_watcher(log_roots, custom_paths, log_tx).await {
                    app_log!("WATCHER", "log watcher stopped with error: {}", e);
                }
            });

            // Shared mapping: agent_id (pid-*) → cwd path
            // Built by scanner consumer, read by log consumer for precise correlation.
            let agent_cwd_map: Arc<RwLock<std::collections::HashMap<String, String>>> =
                Arc::new(RwLock::new(std::collections::HashMap::new()));

            // Spawn scanner event consumer → registry
            let handle_scanner = handle_for_scanner.clone();
            let config_for_scanner = Arc::clone(&config);
            let cwd_map_for_scanner = Arc::clone(&agent_cwd_map);
            tauri::async_runtime::spawn(async move {
                while let Some(event) = scanner_rx.recv().await {
                    let mut reg = registry_for_scanner.write().await;
                    match event {
                        ScannerEvent::AgentFound(ref agent, ref cwd) => {
                            let max = config_for_scanner.read().await.max_agents;
                            if reg.len() >= max as usize {
                                app_log!("SCANNER", "AgentFound: id={} SKIPPED (limit {} reached)", agent.id, max);
                                continue;
                            }
                            app_log!("SCANNER", "AgentFound: id={} name={} pid={:?} cwd={:?}", agent.id, agent.name, agent.pid, cwd);
                            if let Some(cwd_path) = cwd {
                                cwd_map_for_scanner.write().await.insert(agent.id.clone(), cwd_path.clone());
                            }
                            reg.register(agent.clone(), &handle_scanner);
                        }
                        ScannerEvent::AgentLost(ref id) => {
                            app_log!("SCANNER", "AgentLost: id={}", id);
                            cwd_map_for_scanner.write().await.remove(id);
                            reg.remove(id, &handle_scanner);
                        }
                    }
                }
                app_log!("SCANNER", "scanner channel closed, consumer stopping");
            });

            // Spawn JSONL log consumer → state classifier → registry updates
            let registry_for_logs = Arc::clone(&registry);
            let handle_for_logs = handle.clone();
            let config_for_logs = Arc::clone(&config);

            let cwd_map_for_logs = Arc::clone(&agent_cwd_map);
            let parser_for_logs = Arc::clone(&parser_registry);
            tauri::async_runtime::spawn(async move {
                let (debounce_ms, idle_timeout_ms, work_timeout_ms, responding_timeout_ms) = {
                    let cfg = config_for_logs.read().await;
                    (cfg.state_debounce_ms, cfg.idle_timeout_ms, cfg.work_timeout_ms, cfg.responding_timeout_ms)
                };
                let mut classifier = StateClassifier::new(debounce_ms, idle_timeout_ms);
                classifier.set_work_timeout_ms(work_timeout_ms);
                classifier.set_responding_timeout_ms(responding_timeout_ms);

                // Mapping from log-derived IDs (log-{project}) to scanner IDs (pid-{PID})
                // Each entry stores (registry_id, last_seen) to expire stale mappings
                let mut log_to_registry: std::collections::HashMap<String, (String, std::time::Instant)> =
                    std::collections::HashMap::new();

                while let Some(raw) = log_rx.recv().await {
                    app_log!("LOG_RX", "line from {:?} ({}B)", raw.path.file_name(), raw.line.len());

                    if let Some(event) = parser_for_logs.parse_line(&raw.path, &raw.line) {
                        let log_id = path_to_agent_id(&raw.path);

                        let agent_id = {
                            let reg = registry_for_logs.read().await;
                            let cwd_map = cwd_map_for_logs.read().await;
                            resolve_agent_id(&log_id, &mut log_to_registry, &reg, event.cwd.as_deref(), &cwd_map)
                        };

                        app_log!("LOG_PARSE", "status={:?} model={:?} log_id={} → agent_id={}", event.status, event.model, log_id, agent_id);

                        // Log model detection
                        if let Some(ref model) = event.model {
                            app_log!("MODEL", "agent {} detected model='{}'", agent_id, model);
                        }

                        // Log agent lifecycle: start working (Thinking = new task received)
                        if event.status == models::Status::Thinking {
                            app_log!("AGENT", "agent {} started working (received user message)", agent_id);
                        }

                        // Log status-specific transitions for clarity
                        match &event.status {
                            models::Status::Thinking => {
                                app_log!("AGENT", "agent {} → Thinking (processing user input)", agent_id);
                            }
                            models::Status::Responding => {
                                app_log!("AGENT", "agent {} → Responding (generating output)", agent_id);
                            }
                            models::Status::ToolUse => {
                                app_log!("AGENT", "agent {} → ToolUse (executing tool)", agent_id);
                            }
                            models::Status::TaskComplete => {
                                app_log!("AGENT", "agent {} → TaskComplete (finished task)", agent_id);
                            }
                            models::Status::Error => {
                                app_log!("AGENT", "agent {} → Error", agent_id);
                            }
                            _ => {}
                        }

                        // Log sub-agent detection
                        if !event.sub_agents.is_empty() {
                            for sub in &event.sub_agents {
                                app_log!("SUB_AGENT", "agent {} spawned sub-agent id={} desc='{}'", agent_id, sub.id, sub.description);
                            }
                        }

                        // Log sub-agent completion
                        if !event.completed_sub_agent_ids.is_empty() {
                            for completed_id in &event.completed_sub_agent_ids {
                                app_log!("SUB_AGENT", "agent {} sub-agent completed id={}", agent_id, completed_id);
                            }
                        }

                        let transition = classifier.transition(&agent_id, event.status.clone());
                        app_log!("LOG_CLASSIFY", "agent {} transition={:?}", agent_id, transition);

                        // Always accumulate tokens and sub-agent counts, even if
                        // FSM transition is debounced or invalid — data should
                        // never be lost.
                        let has_tokens = event.tokens_in.is_some() || event.tokens_out.is_some();
                        let has_sub_agents = !event.sub_agents.is_empty();
                        let has_completed_subs = !event.completed_sub_agent_ids.is_empty();
                        let is_updated = matches!(transition, TransitionResult::Updated(_));
                        let is_debounced = matches!(transition, TransitionResult::Debounced);

                        if is_updated || is_debounced || has_tokens || has_sub_agents || has_completed_subs {
                            let mut reg = registry_for_logs.write().await;
                            if let Some(mut agent) = reg.get(&agent_id) {
                                if is_updated {
                                    agent.status = event.status;
                                    if let Some(model) = event.model {
                                        let new_tier = models::Tier::from_model(&model);
                                        app_log!("TIER", "agent {} model='{}' → tier {:?} (was {:?})", agent_id, model, new_tier, agent.tier);
                                        agent.tier = new_tier;
                                        agent.model = model;
                                    }
                                    if event.current_task.is_some() {
                                        agent.current_task = event.current_task;
                                    }
                                }
                                // Refresh last_activity on FSM updates, debounced
                                // events (agent is active but self-transition was
                                // suppressed), and completed sub-agent events
                                // (tool_results that arrive after sub-agents finish).
                                // This prevents stale auto-idle timers from firing
                                // while the agent is actively working.
                                if is_updated || is_debounced || has_completed_subs {
                                    agent.last_activity = chrono::Utc::now().to_rfc3339();
                                }
                                agent.sub_agents.extend(event.sub_agents.clone());
                                // Remove completed sub-agents by matching tool_use_id
                                if has_completed_subs {
                                    agent.sub_agents.retain(|s| !event.completed_sub_agent_ids.contains(&s.id));
                                }
                                if let Some(tin) = event.tokens_in {
                                    agent.tokens_in += tin;
                                }
                                if let Some(tout) = event.tokens_out {
                                    agent.tokens_out += tout;
                                }
                                app_log!("LOG_UPDATE", "agent {} → status {:?} tokens_in={} tokens_out={} sub_agents={}", agent_id, agent.status, agent.tokens_in, agent.tokens_out, agent.sub_agents.len());
                                let current_status = agent.status.clone();
                                reg.update(&agent_id, agent, &handle_for_logs);

                                // Schedule auto-idle timer AFTER last_activity is set.
                                // This ensures scheduled_at > last_activity, so the
                                // consumer won't discard the timer as stale.
                                if is_updated {
                                    if let Some(timeout) = classifier.auto_idle_timeout_for(&current_status) {
                                        let tx = idle_tx.clone();
                                        let id = agent_id.clone();
                                        let scheduled_at = std::time::Instant::now();
                                        tokio::spawn(async move {
                                            tokio::time::sleep(std::time::Duration::from_millis(timeout)).await;
                                            if tx.send((id.clone(), models::Status::Idle, scheduled_at)).await.is_err() {
                                                app_log!("AUTO_IDLE", "idle channel closed, cannot send timer for {}", id);
                                            }
                                        });
                                    }
                                }
                            } else {
                                app_log!("LOG_UPDATE", "agent {} not in registry, waiting for scanner", agent_id);
                            }
                        }
                    }
                }
                app_log!("LOG_RX", "log channel closed, consumer stopping");
            });

            // Spawn auto-idle consumer
            // Receives delayed idle transitions from the state classifier.
            // Each message carries `scheduled_at` — the Instant when the timer was created.
            // The consumer discards the timer if the agent received any new events after
            // `scheduled_at` (checked via `last_activity`), preventing premature idle
            // during long-running operations that keep emitting JSONL events.
            let registry_for_idle = Arc::clone(&registry);
            let handle_for_idle = handle.clone();
            tauri::async_runtime::spawn(async move {
                while let Some((agent_id, new_status, scheduled_at)) = idle_rx.recv().await {
                    let mut reg = registry_for_idle.write().await;
                    if let Some(mut agent) = reg.get(&agent_id) {
                        // Only apply auto-idle if agent is still in a work/complete status
                        let is_work_status = matches!(
                            agent.status,
                            models::Status::TaskComplete
                                | models::Status::Thinking
                                | models::Status::Responding
                                | models::Status::ToolUse
                        );
                        // Check if agent received new events after this timer was scheduled.
                        // If last_activity is newer than scheduled_at, the agent is still
                        // actively working — discard this stale timer.
                        // A 100ms tolerance accounts for imprecision when converting between
                        // Instant (monotonic clock) and SystemTime (wall clock). Without it,
                        // timers from the same event can be falsely discarded when last_activity
                        // and scheduled_at are set ~1ms apart but clock conversion reverses
                        // their ordering.
                        let activity_after_schedule = chrono::DateTime::parse_from_rfc3339(&agent.last_activity)
                            .ok()
                            .is_some_and(|activity_time| {
                                let scheduled_system = std::time::SystemTime::now()
                                    - scheduled_at.elapsed();
                                let scheduled_chrono = chrono::DateTime::<chrono::Utc>::from(scheduled_system);
                                let tolerance = chrono::Duration::milliseconds(100);
                                activity_time > scheduled_chrono + tolerance
                            });

                        let has_sub_agents = !agent.sub_agents.is_empty();
                        if is_work_status && !activity_after_schedule && !has_sub_agents {
                            app_log!("AUTO_IDLE", "agent {} → idle (was {:?}, inactivity timeout)", agent_id, agent.status);
                            agent.status = new_status;
                            agent.sub_agents.clear();
                            reg.update(&agent_id, agent, &handle_for_idle);
                        } else if activity_after_schedule {
                            app_log!("AUTO_IDLE", "agent {} → timer discarded (activity after schedule)", agent_id);
                        } else if has_sub_agents {
                            app_log!("AUTO_IDLE", "agent {} → timer skipped ({} sub-agents still running)", agent_id, agent.sub_agents.len());
                        }
                    }
                }
                app_log!("AUTO_IDLE", "idle channel closed, consumer stopping");
            });

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

/// Load AppConfig from the TOML file, falling back to defaults on any error.
fn load_config_or_default() -> AppConfig {
    let path = AppConfig::config_path();
    if !path.exists() {
        app_log!(
            "INIT",
            "config file not found at {:?}, using defaults",
            path
        );
        return AppConfig::default();
    }

    match std::fs::read_to_string(&path) {
        Ok(contents) => toml::from_str(&contents).unwrap_or_else(|e| {
            app_log!("INIT", "config parse error (using defaults): {}", e);
            AppConfig::default()
        }),
        Err(e) => {
            app_log!("INIT", "config read error (using defaults): {}", e);
            AppConfig::default()
        }
    }
}

/// Derive a unique agent id from a log file path.
/// Combines parent project directory name with session UUID prefix to ensure
/// multiple sessions in the same project get distinct IDs.
fn path_to_agent_id(path: &std::path::Path) -> String {
    // Real path: ~/.claude/projects/<project-dir>/<session-uuid>.jsonl
    let parent_name = path
        .parent()
        .and_then(|p| p.file_name())
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| "unknown".to_string());
    let session_suffix = path
        .file_stem()
        .map(|s| {
            let s = s.to_string_lossy();
            if s.len() > 8 {
                s[..8].to_string()
            } else {
                s.to_string()
            }
        })
        .unwrap_or_default();

    if session_suffix.is_empty() {
        format!("log-{parent_name}")
    } else {
        format!("log-{parent_name}--{session_suffix}")
    }
}

/// Resolve a log-derived agent ID to the actual registry ID.
///
/// The process scanner registers agents as `pid-{PID}`, while the log watcher
/// derives IDs as `log-{project}`. This function bridges the gap by mapping
/// log IDs to scanner-registered agents so that log events update the correct
/// agent sprite instead of creating a new one.
///
/// Matching is done by comparing the JSONL `cwd` field with each agent's cwd
/// (recorded by the scanner). This prevents logs from one agent accidentally
/// updating a different agent's state.
///
/// Each mapping entry includes a `last_seen` timestamp. Mappings older than
/// `MAPPING_STALE_SECS` are excluded from the `already_mapped` set, allowing
/// new sessions to claim the same pid-* agent after the old session expires.
fn resolve_agent_id(
    log_id: &str,
    mapping: &mut std::collections::HashMap<String, (String, std::time::Instant)>,
    registry: &discovery::agent_registry::AgentRegistry,
    log_cwd: Option<&str>,
    agent_cwd_map: &std::collections::HashMap<String, String>,
) -> String {
    const MAPPING_STALE_SECS: u64 = 30;

    // 1. Direct match — agent registered under log ID
    if registry.get(log_id).is_some() {
        app_log!("LOG_MATCH", "{} → direct match", log_id);
        return log_id.to_string();
    }

    // 2. Check existing mapping (cached from previous resolution)
    if let Some((mapped_id, _)) = mapping.get(log_id).cloned() {
        if registry.get(&mapped_id).is_some() {
            mapping.get_mut(log_id).unwrap().1 = std::time::Instant::now();
            app_log!("LOG_MATCH", "{} → cached mapping → {}", log_id, mapped_id);
            return mapped_id;
        }
        // Stale mapping — agent was removed from registry
        app_log!(
            "LOG_MATCH",
            "{} → stale mapping to {} (agent gone), clearing",
            log_id,
            mapped_id
        );
        mapping.remove(log_id);
    }

    // 3. Match by cwd — find a pid-* agent whose cwd matches the JSONL cwd
    if let Some(cwd) = log_cwd {
        let now = std::time::Instant::now();
        let already_mapped: std::collections::HashSet<&String> = mapping
            .iter()
            .filter(|(_, (_, last_seen))| {
                now.duration_since(*last_seen).as_secs() < MAPPING_STALE_SECS
            })
            .map(|(_, (pid, _))| pid)
            .collect();

        // Build ever_mapped: ALL agents that have ANY mapping entry (even stale).
        // Used to prefer never-mapped agents when multiple candidates share the same CWD.
        let ever_mapped: std::collections::HashSet<&String> =
            mapping.iter().map(|(_, (pid, _))| pid).collect();

        // Collect all CWD-matching candidates (excluding actively mapped)
        let mut candidates: Vec<String> = Vec::new();
        for agent in registry.get_all() {
            if !agent.id.starts_with("pid-") || already_mapped.contains(&agent.id) {
                continue;
            }
            if let Some(agent_cwd) = agent_cwd_map.get(&agent.id) {
                // Compare with prefix: JSONL cwd may be a subdirectory of the process cwd
                // or vice versa (e.g. scanner sees /project, JSONL has /project/subdir)
                if cwd.starts_with(agent_cwd.as_str()) || agent_cwd.starts_with(cwd) {
                    candidates.push(agent.id.clone());
                }
            }
        }

        // Prefer never-mapped agents (priority 0) over previously-mapped ones (priority 1)
        candidates.sort_by_key(|id| if ever_mapped.contains(id) { 1u8 } else { 0u8 });

        if let Some(best_id) = candidates.first() {
            app_log!(
                "LOG_MATCH",
                "{} → cwd match → {} (cwd={}, candidates={})",
                log_id,
                best_id,
                cwd,
                candidates.len()
            );
            mapping.insert(log_id.to_string(), (best_id.clone(), now));
            return best_id.clone();
        }
    }

    // No match found — return log ID as-is (will be ignored by registry lookup)
    app_log!(
        "LOG_MATCH",
        "{} → no match found (cwd={:?})",
        log_id,
        log_cwd
    );
    log_id.to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use discovery::agent_registry::AgentRegistry;
    use models::{AgentState, IdleLocation, Source, Status, Tier};
    use std::time::Instant;

    fn make_agent(id: &str) -> AgentState {
        AgentState {
            id: id.to_string(),
            pid: Some(1234),
            name: "claude".to_string(),
            model: "claude".to_string(),
            tier: Tier::Middle,
            role: "agent".to_string(),
            status: Status::Idle,
            idle_location: IdleLocation::Desk,
            current_task: None,
            tokens_in: 0,
            tokens_out: 0,
            sub_agents: vec![],
            last_activity: "2026-01-01T00:00:00Z".to_string(),
            source: Source::Cli,
        }
    }

    #[test]
    fn test_path_to_agent_id_from_project_path() {
        let path = std::path::Path::new(
            "/home/user/.claude/projects/-Users-me-myproject/8fea29d9-1234-5678-abcd-ef0123456789.jsonl",
        );
        assert_eq!(path_to_agent_id(path), "log--Users-me-myproject--8fea29d9");
    }

    #[test]
    fn test_path_to_agent_id_short_filename() {
        let path =
            std::path::Path::new("/home/user/.claude/projects/-Users-me-myproject/abc.jsonl");
        assert_eq!(path_to_agent_id(path), "log--Users-me-myproject--abc");
    }

    #[test]
    fn test_resolve_direct_match() {
        let mut registry = AgentRegistry::new();
        registry.insert_for_test(make_agent("log-myproject"));
        let mut mapping = std::collections::HashMap::new();
        let cwd_map = std::collections::HashMap::new();

        let result = resolve_agent_id("log-myproject", &mut mapping, &registry, None, &cwd_map);
        assert_eq!(result, "log-myproject");
        assert!(mapping.is_empty());
    }

    #[test]
    fn test_resolve_maps_log_to_pid_by_cwd() {
        let mut registry = AgentRegistry::new();
        registry.insert_for_test(make_agent("pid-12345"));
        let mut mapping = std::collections::HashMap::new();
        let mut cwd_map = std::collections::HashMap::new();
        cwd_map.insert("pid-12345".to_string(), "/home/user/myproject".to_string());

        let result = resolve_agent_id(
            "log-myproject",
            &mut mapping,
            &registry,
            Some("/home/user/myproject"),
            &cwd_map,
        );
        assert_eq!(result, "pid-12345");
        assert_eq!(
            mapping.get("log-myproject").map(|(id, _)| id.as_str()),
            Some("pid-12345")
        );
    }

    #[test]
    fn test_resolve_uses_cached_mapping() {
        let mut registry = AgentRegistry::new();
        registry.insert_for_test(make_agent("pid-12345"));
        let mut mapping = std::collections::HashMap::new();
        mapping.insert(
            "log-myproject".to_string(),
            ("pid-12345".to_string(), Instant::now()),
        );
        let cwd_map = std::collections::HashMap::new();

        let result = resolve_agent_id("log-myproject", &mut mapping, &registry, None, &cwd_map);
        assert_eq!(result, "pid-12345");
    }

    #[test]
    fn test_resolve_clears_stale_mapping() {
        let registry = AgentRegistry::new();
        let mut mapping = std::collections::HashMap::new();
        mapping.insert(
            "log-myproject".to_string(),
            ("pid-99999".to_string(), Instant::now()),
        );
        let cwd_map = std::collections::HashMap::new();

        let result = resolve_agent_id("log-myproject", &mut mapping, &registry, None, &cwd_map);
        // Agent pid-99999 not in registry — returns log ID as fallback
        assert_eq!(result, "log-myproject");
        assert!(!mapping.contains_key("log-myproject"));
    }

    #[test]
    fn test_resolve_no_match_returns_log_id() {
        let registry = AgentRegistry::new();
        let mut mapping = std::collections::HashMap::new();
        let cwd_map = std::collections::HashMap::new();

        let result = resolve_agent_id("log-myproject", &mut mapping, &registry, None, &cwd_map);
        assert_eq!(result, "log-myproject");
    }

    #[test]
    fn test_resolve_does_not_cross_match_different_cwd() {
        let mut registry = AgentRegistry::new();
        registry.insert_for_test(make_agent("pid-100"));
        registry.insert_for_test(make_agent("pid-200"));
        let mut mapping = std::collections::HashMap::new();
        let mut cwd_map = std::collections::HashMap::new();
        cwd_map.insert("pid-100".to_string(), "/home/user/project-a".to_string());
        cwd_map.insert("pid-200".to_string(), "/home/user/project-b".to_string());

        // Log from project-c should NOT match any agent
        let result = resolve_agent_id(
            "log-project-c",
            &mut mapping,
            &registry,
            Some("/home/user/project-c"),
            &cwd_map,
        );
        assert_eq!(result, "log-project-c");
        assert!(mapping.is_empty());
    }

    #[test]
    fn test_resolve_matches_correct_agent_by_cwd() {
        let mut registry = AgentRegistry::new();
        registry.insert_for_test(make_agent("pid-100"));
        registry.insert_for_test(make_agent("pid-200"));
        let mut mapping = std::collections::HashMap::new();
        let mut cwd_map = std::collections::HashMap::new();
        cwd_map.insert("pid-100".to_string(), "/home/user/project-a".to_string());
        cwd_map.insert("pid-200".to_string(), "/home/user/project-b".to_string());

        // Log from project-b should match pid-200, NOT pid-100
        let result = resolve_agent_id(
            "log-project-b",
            &mut mapping,
            &registry,
            Some("/home/user/project-b"),
            &cwd_map,
        );
        assert_eq!(result, "pid-200");
    }

    #[test]
    fn test_resolve_matches_subdirectory_cwd() {
        let mut registry = AgentRegistry::new();
        registry.insert_for_test(make_agent("pid-100"));
        let mut mapping = std::collections::HashMap::new();
        let mut cwd_map = std::collections::HashMap::new();
        // Scanner sees root project dir
        cwd_map.insert("pid-100".to_string(), "/home/user/project".to_string());

        // JSONL cwd is a subdirectory of the scanner cwd
        let result = resolve_agent_id(
            "log-project",
            &mut mapping,
            &registry,
            Some("/home/user/project/src/subdir"),
            &cwd_map,
        );
        assert_eq!(result, "pid-100");
    }

    #[test]
    fn test_resolve_two_sessions_same_project_map_to_different_agents() {
        let mut registry = AgentRegistry::new();
        registry.insert_for_test(make_agent("pid-100"));
        registry.insert_for_test(make_agent("pid-200"));
        let mut mapping = std::collections::HashMap::new();
        let mut cwd_map = std::collections::HashMap::new();
        cwd_map.insert("pid-100".to_string(), "/home/user/myproject".to_string());
        cwd_map.insert("pid-200".to_string(), "/home/user/myproject".to_string());

        let log_id_1 = "log--Users-user-myproject--aaaaaaaa";
        let log_id_2 = "log--Users-user-myproject--bbbbbbbb";

        let result1 = resolve_agent_id(
            log_id_1,
            &mut mapping,
            &registry,
            Some("/home/user/myproject"),
            &cwd_map,
        );
        let result2 = resolve_agent_id(
            log_id_2,
            &mut mapping,
            &registry,
            Some("/home/user/myproject"),
            &cwd_map,
        );

        assert!(result1.starts_with("pid-"));
        assert!(result2.starts_with("pid-"));
        assert_ne!(
            result1, result2,
            "Two sessions in same project must map to different agents"
        );
    }

    #[test]
    fn test_resolve_three_sessions_two_agents_third_falls_back() {
        let mut registry = AgentRegistry::new();
        registry.insert_for_test(make_agent("pid-100"));
        registry.insert_for_test(make_agent("pid-200"));
        let mut mapping = std::collections::HashMap::new();
        let mut cwd_map = std::collections::HashMap::new();
        cwd_map.insert("pid-100".to_string(), "/home/user/myproject".to_string());
        cwd_map.insert("pid-200".to_string(), "/home/user/myproject".to_string());

        let log_id_1 = "log--Users-user-myproject--11111111";
        let log_id_2 = "log--Users-user-myproject--22222222";
        let log_id_3 = "log--Users-user-myproject--33333333";

        resolve_agent_id(
            log_id_1,
            &mut mapping,
            &registry,
            Some("/home/user/myproject"),
            &cwd_map,
        );
        resolve_agent_id(
            log_id_2,
            &mut mapping,
            &registry,
            Some("/home/user/myproject"),
            &cwd_map,
        );
        let result3 = resolve_agent_id(
            log_id_3,
            &mut mapping,
            &registry,
            Some("/home/user/myproject"),
            &cwd_map,
        );

        assert_eq!(
            result3, log_id_3,
            "Third session has no free pid-* agent, falls back to log_id"
        );
    }

    #[test]
    fn test_resolve_stale_mapping_allows_new_session() {
        let mut registry = AgentRegistry::new();
        registry.insert_for_test(make_agent("pid-100"));
        let mut mapping = std::collections::HashMap::new();
        // Old session mapped 60 seconds ago — well past the 30s staleness threshold
        let stale_time = Instant::now() - std::time::Duration::from_secs(60);
        mapping.insert(
            "log-project--session1".to_string(),
            ("pid-100".to_string(), stale_time),
        );
        let mut cwd_map = std::collections::HashMap::new();
        cwd_map.insert("pid-100".to_string(), "/home/user/project".to_string());

        // New session should claim pid-100 because the old mapping is stale
        let result = resolve_agent_id(
            "log-project--session2",
            &mut mapping,
            &registry,
            Some("/home/user/project"),
            &cwd_map,
        );
        assert_eq!(
            result, "pid-100",
            "Stale mapping should not block new session from claiming the same agent"
        );
        assert_eq!(
            mapping
                .get("log-project--session2")
                .map(|(id, _)| id.as_str()),
            Some("pid-100"),
        );
    }

    #[test]
    fn test_resolve_prefers_never_mapped_agent() {
        let mut registry = AgentRegistry::new();
        registry.insert_for_test(make_agent("pid-100"));
        registry.insert_for_test(make_agent("pid-200"));
        let mut mapping = std::collections::HashMap::new();
        // pid-100 has a stale mapping from an old session (>30s ago)
        let stale_time = Instant::now() - std::time::Duration::from_secs(60);
        mapping.insert(
            "log-project--old-session".to_string(),
            ("pid-100".to_string(), stale_time),
        );
        let mut cwd_map = std::collections::HashMap::new();
        cwd_map.insert("pid-100".to_string(), "/home/user/project".to_string());
        cwd_map.insert("pid-200".to_string(), "/home/user/project".to_string());

        // New session should prefer pid-200 (never mapped) over pid-100 (stale mapping)
        let result = resolve_agent_id(
            "log-project--new-session",
            &mut mapping,
            &registry,
            Some("/home/user/project"),
            &cwd_map,
        );
        assert_eq!(
            result, "pid-200",
            "Should prefer never-mapped agent over previously-mapped one"
        );
    }

    #[test]
    fn test_resolve_falls_back_to_stale_mapped_agent() {
        let mut registry = AgentRegistry::new();
        registry.insert_for_test(make_agent("pid-100"));
        let mut mapping = std::collections::HashMap::new();
        // pid-100 has a stale mapping — but it's the ONLY candidate
        let stale_time = Instant::now() - std::time::Duration::from_secs(60);
        mapping.insert(
            "log-project--old-session".to_string(),
            ("pid-100".to_string(), stale_time),
        );
        let mut cwd_map = std::collections::HashMap::new();
        cwd_map.insert("pid-100".to_string(), "/home/user/project".to_string());

        // New session should still claim pid-100 since it's the only CWD match
        let result = resolve_agent_id(
            "log-project--new-session",
            &mut mapping,
            &registry,
            Some("/home/user/project"),
            &cwd_map,
        );
        assert_eq!(
            result, "pid-100",
            "Should fall back to stale-mapped agent when no unmapped candidates exist"
        );
    }
}
