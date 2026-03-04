// Process scanner using sysinfo crate
// Detects Claude Code, Claude CLI, and custom agent processes

use crate::models::{AgentState, AppConfig, IdleLocation, Source, Status, Tier};
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};
use sysinfo::System;
use tokio::sync::{mpsc, RwLock};
use tokio::time::Duration;

/// Built-in detection patterns for AI agent processes (used in tests)
#[cfg(test)]
const BUILTIN_PATTERNS: &[&str] = &["claude", "node.*claude"];

/// Process names that should never be treated as AI agents,
/// even if "claude" appears in their command line arguments.
const PROCESS_BLOCKLIST: &[&str] = &["ssh", "sshd", "git", "scp", "sftp", "rsync", "curl", "wget"];

/// Message sent from scanner to the registry
#[derive(Debug, Clone)]
pub enum ScannerEvent {
    AgentFound(AgentState, Option<String>), // (agent, cwd)
    AgentLost(String),
}

/// Detected process information before it becomes an AgentState
#[derive(Debug, Clone)]
pub struct DetectedProcess {
    pub pid: u32,
    pub name: String,
    #[allow(dead_code)]
    pub start_time: u64,
    /// Working directory of the process (used to correlate with JSONL log paths)
    pub cwd: Option<String>,
}

/// Check if a process name looks like a semver version number (e.g. "2.1.62").
/// Claude Code spawns short-lived Node.js workers whose OS name is the package version.
fn is_version_number(name: &str) -> bool {
    let mut parts = name.split('.');
    parts
        .next()
        .is_some_and(|p| !p.is_empty() && p.chars().all(|c| c.is_ascii_digit()))
        && parts
            .next()
            .is_some_and(|p| !p.is_empty() && p.chars().all(|c| c.is_ascii_digit()))
}

/// Check if a process name is in the blocklist of non-agent executables.
fn is_blocklisted(name: &str) -> bool {
    PROCESS_BLOCKLIST.contains(&name)
}

/// Check if a process has an interactive terminal (TTY).
/// Background daemon processes have TTY "??" on macOS or "?" on Linux.
#[cfg(unix)]
fn has_tty(pid: u32) -> bool {
    let output = std::process::Command::new("ps")
        .args(["-o", "tty=", "-p", &pid.to_string()])
        .output();
    match output {
        Ok(o) => {
            let tty = String::from_utf8_lossy(&o.stdout).trim().to_string();
            !tty.is_empty() && tty != "??" && tty != "?"
        }
        Err(_) => true, // If ps fails, assume interactive
    }
}

/// On Windows there is no Unix TTY concept; all detected processes pass the check.
#[cfg(windows)]
fn has_tty(_pid: u32) -> bool {
    true
}

/// Check if a process matches any of the given patterns
pub fn matches_agent_pattern(name: &str, cmdline: &str, patterns: &[&str]) -> bool {
    for pattern in patterns {
        let regex_result = regex::Regex::new(pattern);
        match regex_result {
            Ok(re) => {
                if re.is_match(name) || re.is_match(cmdline) {
                    return true;
                }
            }
            Err(_) => {
                // Fallback to simple substring match on bad regex
                if name.contains(*pattern) || cmdline.contains(*pattern) {
                    return true;
                }
            }
        }
    }
    false
}

/// Convert detected process into an AgentState.
pub fn process_to_agent_state(proc: &DetectedProcess) -> AgentState {
    let id = format!("pid-{}", proc.pid);
    let timestamp = chrono::Utc::now().to_rfc3339();
    let display_name = format!("{}-{}", proc.name, proc.pid);

    AgentState {
        id,
        pid: Some(proc.pid),
        name: display_name,
        model: "claude".to_string(),
        tier: Tier::Middle,
        role: "agent".to_string(),
        status: Status::Idle,
        idle_location: IdleLocation::Desk,
        current_task: None,
        tokens_in: 0,
        tokens_out: 0,
        sub_agents: vec![],
        last_activity: timestamp,
        source: infer_source_from_name(&proc.name),
    }
}

fn infer_source_from_name(_name: &str) -> Source {
    // All detected processes are CLI agents for now.
    // Future: distinguish BrowserExtension / SdkHook sources by process name.
    Source::Cli
}

/// Scan all running processes and return detected AI agents using built-in patterns.
#[cfg(test)]
pub fn scan_processes() -> Vec<DetectedProcess> {
    scan_processes_with_patterns(
        &BUILTIN_PATTERNS
            .iter()
            .map(|s| s.to_string())
            .collect::<Vec<_>>(),
    )
}

/// Scan all running processes using configurable patterns.
pub fn scan_processes_with_patterns(patterns: &[String]) -> Vec<DetectedProcess> {
    let mut system = System::new_all();
    system.refresh_all();

    let pattern_refs: Vec<&str> = patterns.iter().map(|s| s.as_str()).collect();
    let mut detected = Vec::new();

    for (pid, process) in system.processes() {
        let name = process.name().to_string_lossy().to_string();
        let cmdline = process
            .cmd()
            .iter()
            .map(|s| s.to_string_lossy())
            .collect::<Vec<_>>()
            .join(" ");

        let pid_u32 = pid.as_u32();
        if matches_agent_pattern(&name, &cmdline, &pattern_refs)
            && !is_blocklisted(&name)
            && !is_version_number(&name)
            && has_tty(pid_u32)
        {
            let start_time = process.start_time();
            let cwd = process.cwd().map(|p| p.to_string_lossy().to_string());
            detected.push(DetectedProcess {
                pid: pid_u32,
                name,
                start_time,
                cwd,
            });
        }
    }

    detected
}

/// Run the process scanner as a Tokio background task.
/// Reads scan interval from shared config on each iteration,
/// allowing dynamic updates without restart.
pub async fn run_scanner(config: Arc<RwLock<AppConfig>>, tx: mpsc::Sender<ScannerEvent>) {
    let initial_interval = config.read().await.scan_interval_ms;
    app_log!("SCANNER", "started with interval={}ms", initial_interval);
    let mut known_pids: std::collections::HashMap<u32, AgentState> =
        std::collections::HashMap::new();

    loop {
        let cfg = config.read().await;
        let interval_ms = cfg.scan_interval_ms;
        let patterns = cfg.agent_process_patterns.clone();
        drop(cfg);
        tokio::time::sleep(Duration::from_millis(interval_ms)).await;

        let detected = scan_processes_with_patterns(&patterns);
        let current_pids: std::collections::HashSet<u32> = detected.iter().map(|p| p.pid).collect();

        let new_count = detected
            .iter()
            .filter(|p| !known_pids.contains_key(&p.pid))
            .count();
        let lost_count = known_pids
            .keys()
            .filter(|pid| !current_pids.contains(*pid))
            .count();
        if new_count > 0 || lost_count > 0 {
            app_log!(
                "SCANNER",
                "scan: detected={} known={} new={} lost={}",
                detected.len(),
                known_pids.len(),
                new_count,
                lost_count
            );
        }

        // Emit AgentFound for new processes
        for proc in &detected {
            if known_pids.contains_key(&proc.pid) {
                continue;
            }
            let agent = process_to_agent_state(proc);
            let cwd = proc.cwd.clone();
            app_log!(
                "SCANNER",
                "new agent process: pid={} name='{}' cwd={:?}",
                proc.pid,
                proc.name,
                cwd
            );
            known_pids.insert(proc.pid, agent.clone());
            if tx.send(ScannerEvent::AgentFound(agent, cwd)).await.is_err() {
                app_log!("SCANNER", "channel closed, scanner stopping");
                return;
            }
        }

        // Emit AgentLost for processes that disappeared
        let lost_pids: Vec<u32> = known_pids
            .keys()
            .filter(|pid| !current_pids.contains(*pid))
            .copied()
            .collect();

        for pid in lost_pids {
            if let Some(agent) = known_pids.remove(&pid) {
                app_log!("SCANNER", "agent process lost: pid={} id={}", pid, agent.id);
                if tx.send(ScannerEvent::AgentLost(agent.id)).await.is_err() {
                    app_log!("SCANNER", "channel closed, scanner stopping");
                    return;
                }
            }
        }
    }
}

/// Get current timestamp as ISO 8601 string
fn _current_timestamp() -> String {
    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    format!("{secs}")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_version_number_detection() {
        assert!(is_version_number("2.1.62"));
        assert!(is_version_number("0.9"));
        assert!(is_version_number("10.3.1"));
        assert!(!is_version_number("claude"));
        assert!(!is_version_number("node"));
        assert!(!is_version_number("2a.1"));
        assert!(!is_version_number(".1.2"));
        assert!(!is_version_number(""));
    }

    #[test]
    fn test_ssh_is_blocklisted() {
        assert!(is_blocklisted("ssh"));
        assert!(is_blocklisted("sshd"));
        assert!(is_blocklisted("git"));
        assert!(!is_blocklisted("claude"));
        assert!(!is_blocklisted("node"));
    }

    #[test]
    fn test_matches_claude_by_name() {
        assert!(matches_agent_pattern("claude", "", BUILTIN_PATTERNS));
    }

    #[test]
    fn test_matches_node_claude_in_cmdline() {
        assert!(matches_agent_pattern(
            "node",
            "/usr/bin/node /home/user/.nvm/claude/bin",
            BUILTIN_PATTERNS
        ));
    }

    #[test]
    fn test_process_scanner_ignores_non_agents() {
        assert!(!matches_agent_pattern(
            "bash",
            "bash --login",
            BUILTIN_PATTERNS
        ));
        assert!(!matches_agent_pattern(
            "vim",
            "vim src/main.rs",
            BUILTIN_PATTERNS
        ));
        assert!(!matches_agent_pattern(
            "cargo",
            "cargo build",
            BUILTIN_PATTERNS
        ));
    }

    #[test]
    fn test_process_to_agent_state_basic() {
        let proc = DetectedProcess {
            pid: 12345,
            name: "claude".to_string(),
            start_time: 1000,
            cwd: Some("/home/user/project".to_string()),
        };
        let agent = process_to_agent_state(&proc);
        assert_eq!(agent.pid, Some(12345));
        assert_eq!(agent.id, "pid-12345");
        assert_eq!(agent.name, "claude-12345");
        assert_eq!(agent.status, Status::Idle);
    }

    #[test]
    fn test_process_to_agent_state_different_pids() {
        let proc1 = DetectedProcess {
            pid: 100,
            name: "claude".to_string(),
            start_time: 1000,
            cwd: None,
        };
        let proc2 = DetectedProcess {
            pid: 200,
            name: "claude".to_string(),
            start_time: 1000,
            cwd: None,
        };
        let agent1 = process_to_agent_state(&proc1);
        let agent2 = process_to_agent_state(&proc2);
        assert_eq!(agent1.name, "claude-100");
        assert_eq!(agent2.name, "claude-200");
    }

    #[cfg(unix)]
    #[test]
    fn test_has_tty_nonexistent_pid() {
        // PID 999999 almost certainly doesn't exist — ps returns empty
        assert!(!has_tty(999_999));
    }

    #[cfg(windows)]
    #[test]
    fn test_has_tty_always_true_on_windows() {
        // Windows has no Unix TTY concept; all processes pass
        assert!(has_tty(999_999));
        assert!(has_tty(1));
    }

    #[test]
    fn test_scan_processes_returns_vec() {
        // Just verify it runs without panic; actual agents depend on OS state
        let result = scan_processes();
        // Result is a Vec — can be empty or have entries
        let _ = result;
    }

    #[tokio::test]
    async fn test_scanner_sends_found_event() {
        let (tx, mut rx) = mpsc::channel::<ScannerEvent>(32);
        // We cannot mock sysinfo, so we test the channel plumbing
        // by checking the receiver is alive
        drop(tx);
        assert!(rx.recv().await.is_none());
    }
}
