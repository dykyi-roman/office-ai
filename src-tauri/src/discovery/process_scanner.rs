// Process scanner using sysinfo crate
// Detects Claude Code, Claude CLI, and custom agent processes

use crate::models::{AgentState, AppConfig, IdleLocation, Source, Status, Tier};
use std::collections::HashMap;
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};
use sysinfo::System;
use tokio::sync::{mpsc, RwLock};
use tokio::time::Duration;

/// Built-in detection patterns for AI agent processes (used in tests)
#[cfg(test)]
const BUILTIN_PATTERNS: &[&str] = &[
    "claude",
    "node.*claude",
    "gemini",
    "node.*gemini",
    "codex",
    "node.*codex",
];

/// Process names that should never be treated as AI agents,
/// even if "claude" appears in their command line arguments.
const PROCESS_BLOCKLIST: &[&str] = &[
    "ssh",
    "sshd",
    "git",
    "scp",
    "sftp",
    "rsync",
    "curl",
    "wget",
    "Cursor Helper",
    "CursorUIViewService",
    "Windsurf Helper",
];

/// Known GUI-based AI agent process names (Electron apps without TTY).
/// These bypass the TTY filter that normally excludes non-interactive processes.
const GUI_AGENT_NAMES: &[&str] = &["cursor", "windsurf"];

/// Message sent from scanner to the registry
#[derive(Debug, Clone)]
pub enum ScannerEvent {
    AgentFound(AgentState, Option<String>), // (agent, cwd)
    AgentLost(String),
    CwdUpdated(String, String), // (agent_id, new_cwd)
}

/// Detected process information before it becomes an AgentState
#[derive(Debug, Clone)]
pub struct DetectedProcess {
    pub pid: u32,
    pub name: String,
    /// Full command-line string (from ps), used for agent type inference
    pub cmdline: String,
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
    PROCESS_BLOCKLIST
        .iter()
        .any(|&blocked| name == blocked || name.starts_with(blocked))
}

/// Check if a process is a known GUI-based AI agent (e.g. Cursor, Windsurf).
/// These are Electron apps that don't have a TTY but should still be detected.
fn is_gui_agent(name: &str, cmdline: &str) -> bool {
    let lower = name.to_lowercase();
    let lower_cmd = cmdline.to_lowercase();
    GUI_AGENT_NAMES
        .iter()
        .any(|&kw| lower.contains(kw) || lower_cmd.contains(kw))
}

/// Check if a process has an interactive terminal (TTY).
/// Used in tests to verify TTY detection logic.
#[cfg(all(unix, test))]
fn has_tty(pid: u32) -> bool {
    let output = std::process::Command::new("ps")
        .args(["-o", "tty=", "-p", &pid.to_string()])
        .output();
    match output {
        Ok(o) => {
            let tty = String::from_utf8_lossy(&o.stdout).trim().to_string();
            !tty.is_empty() && tty != "??" && tty != "?"
        }
        Err(_) => true,
    }
}

/// A raw process entry from `ps` with PID, TTY, PPID, stat, and full command line.
struct PsEntry {
    pid: u32,
    ppid: u32,
    tty: String,
    /// Process state from `ps`: R=Running, S=Sleeping, T=Stopped, Z=Zombie, etc.
    stat: String,
    args: String,
}

/// Enumerate all processes using `ps` (reliable on macOS, even from GUI/Tauri apps).
/// sysinfo may not enumerate all processes (especially Node.js child processes)
/// in the Tauri app context, so `ps` is the primary source of truth for detection.
#[cfg(unix)]
fn get_ps_entries() -> Vec<PsEntry> {
    let output = std::process::Command::new("ps")
        .args(["axo", "pid,ppid,tty,stat,args"])
        .output();
    let Ok(o) = output else {
        return vec![];
    };
    let text = String::from_utf8_lossy(&o.stdout);
    let mut entries = Vec::new();
    for line in text.lines().skip(1) {
        let fields: Vec<&str> = line.split_whitespace().collect();
        // Minimum: pid ppid tty stat command
        if fields.len() < 5 {
            continue;
        }
        let Ok(pid) = fields[0].parse::<u32>() else {
            continue;
        };
        let ppid = fields[1].parse::<u32>().unwrap_or(0);
        let tty = fields[2].to_string();
        let stat = fields[3].to_string();
        // args is everything from fields[4] onward (command may contain spaces)
        let args = fields[4..].join(" ");
        entries.push(PsEntry {
            pid,
            ppid,
            tty,
            stat,
            args,
        });
    }
    entries
}

/// Fallback process enumeration on Windows using `sysinfo`.
/// Since `ps` is Unix-only, we use sysinfo to list all processes on Windows.
/// Limitations: no TTY info (all pass), no PPID (no parent-child dedup),
/// no stat (no stopped/zombie filtering).
#[cfg(windows)]
fn get_ps_entries() -> Vec<PsEntry> {
    let mut system = System::new_all();
    system.refresh_all();
    system
        .processes()
        .iter()
        .map(|(pid, proc_info)| {
            let args = proc_info
                .cmd()
                .iter()
                .map(|s| s.to_string_lossy().to_string())
                .collect::<Vec<_>>()
                .join(" ");
            PsEntry {
                pid: pid.as_u32(),
                ppid: proc_info.parent().map(|p| p.as_u32()).unwrap_or(0),
                tty: "console".to_string(), // Windows has no TTY; treat all as interactive
                stat: "S".to_string(),      // No stat info; assume running
                args,
            }
        })
        .collect()
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

/// Keyword → model lookup table for process detection.
/// Order matters: first match wins. Add new agent keywords here.
const MODEL_KEYWORDS: &[(&str, &str)] = &[
    ("gemini", "gemini"),
    ("claude", "claude"),
    ("codex", "codex"),
    ("aider", "aider"),
    ("cursor", "cursor"),
    ("windsurf", "windsurf"),
    ("copilot", "copilot"),
];

/// Infer the initial model name from the process name and command line.
/// Checks custom keywords first (user-defined, from config), then built-in MODEL_KEYWORDS.
/// Returns "unknown" if no keyword matches.
pub fn infer_initial_model(
    name: &str,
    cmdline: &str,
    custom_keywords: &HashMap<String, String>,
) -> String {
    let lower_name = name.to_lowercase();
    let lower_cmd = cmdline.to_lowercase();
    // Custom keywords take priority
    for (keyword, model) in custom_keywords {
        let kw = keyword.to_lowercase();
        if lower_name.contains(&kw) || lower_cmd.contains(&kw) {
            return model.clone();
        }
    }
    // Fall back to built-in keywords
    for &(keyword, model) in MODEL_KEYWORDS {
        if lower_name.contains(keyword) || lower_cmd.contains(keyword) {
            return model.to_string();
        }
    }
    "unknown".to_string()
}

/// Derive a human-friendly agent name from process name and command line.
/// For Node.js processes running agent scripts (e.g. `node .../gemini`),
/// extracts the script name instead of using "node".
fn derive_agent_name(name: &str, cmdline: &str) -> String {
    if name == "node" {
        // Extract the script basename from cmdline args
        // e.g. "node --no-warnings=DEP0040 /opt/homebrew/bin/gemini" → "gemini"
        for arg in cmdline.split_whitespace() {
            if arg.starts_with('-') {
                continue;
            }
            // Skip the "node" binary itself
            let basename = std::path::Path::new(arg)
                .file_name()
                .map(|n| n.to_string_lossy().to_string())
                .unwrap_or_default();
            if basename == "node" || basename.is_empty() {
                continue;
            }
            return basename;
        }
    }
    name.to_string()
}

/// Convert detected process into an AgentState.
/// Accepts custom model keywords from config for extensible model inference.
pub fn process_to_agent_state(
    proc: &DetectedProcess,
    custom_keywords: &HashMap<String, String>,
) -> AgentState {
    let id = format!("pid-{}", proc.pid);
    let timestamp = chrono::Utc::now().to_rfc3339();
    let agent_name = derive_agent_name(&proc.name, &proc.cmdline);
    let display_name = format!("{}-{}", agent_name, proc.pid);

    AgentState {
        id,
        pid: Some(proc.pid),
        name: display_name,
        model: infer_initial_model(&proc.name, &proc.cmdline, custom_keywords),
        tier: Tier::Middle,
        role: "agent".to_string(),
        status: Status::Idle,
        idle_location: IdleLocation::Desk,
        current_task: None,
        tokens_in: 0,
        tokens_out: 0,
        sub_agents: vec![],
        last_activity: timestamp.clone(),
        started_at: timestamp,
        source: infer_source_from_name(&proc.name),
    }
}

fn infer_source_from_name(name: &str) -> Source {
    let lower = name.to_lowercase();
    if GUI_AGENT_NAMES.iter().any(|&kw| lower.contains(kw)) {
        return Source::Ide;
    }
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
        false,
        None,
    )
}

/// Scan all running processes using configurable patterns.
///
/// Uses `ps` as the primary process source (reliable on macOS, even from GUI apps).
/// sysinfo may skip some processes (especially Node.js child processes) in Tauri context,
/// so it's used only for supplementary metadata (cwd, start_time).
///
/// After detection, deduplicates parent-child process pairs (e.g. Gemini CLI
/// spawns a child node process with the same args — only the parent is kept).
///
/// Accepts an optional cached `System` instance to avoid re-creating it on every scan.
/// When `None`, creates a new instance (used in tests and one-off calls).
pub fn scan_processes_with_patterns(
    patterns: &[String],
    debug_mode: bool,
    system: Option<&mut System>,
) -> Vec<DetectedProcess> {
    let ps_entries = get_ps_entries();

    // Use provided system or create a temporary one for supplementary metadata
    let mut temp_system;
    let system = match system {
        Some(s) => {
            s.refresh_processes(sysinfo::ProcessesToUpdate::All, true);
            s
        }
        None => {
            temp_system = System::new_all();
            temp_system.refresh_all();
            &mut temp_system
        }
    };

    let pattern_refs: Vec<&str> = patterns.iter().map(|s| s.as_str()).collect();
    let mut detected = Vec::new();
    let mut parent_pids: std::collections::HashMap<u32, u32> = std::collections::HashMap::new();

    for entry in &ps_entries {
        // Extract process name (basename of first arg)
        let name = entry
            .args
            .split_whitespace()
            .next()
            .map(|first_arg| {
                std::path::Path::new(first_arg)
                    .file_name()
                    .map(|n| n.to_string_lossy().to_string())
                    .unwrap_or_else(|| first_arg.to_string())
            })
            .unwrap_or_default();

        let pattern_match = matches_agent_pattern(&name, &entry.args, &pattern_refs);
        if !pattern_match {
            continue;
        }

        let blocked = is_blocklisted(&name);
        let version = is_version_number(&name);
        let has_interactive_tty = !entry.tty.is_empty() && entry.tty != "??" && entry.tty != "?";
        let gui_agent = is_gui_agent(&name, &entry.args);
        // Filter stopped/suspended processes (stat starts with 'T').
        // When a terminal tab is closed, the child process may receive SIGTSTP
        // and enter stopped state instead of dying — treat it as gone.
        let is_stopped = entry.stat.starts_with('T');

        // GUI agents (Cursor, Windsurf) don't have a TTY — bypass TTY filter for them
        if blocked || version || is_stopped {
            app_log_debug!(
                debug_mode,
                "SCANNER",
                "filtered out pid={} name='{}' blocked={} version={} stat={} cmdline='{}'",
                entry.pid,
                name,
                blocked,
                version,
                entry.stat,
                &entry.args[..entry.args.len().min(120)]
            );
            continue;
        }
        if !has_interactive_tty && !gui_agent {
            app_log_debug!(
                debug_mode,
                "SCANNER",
                "filtered out pid={} name='{}' no_tty tty={} cmdline='{}'",
                entry.pid,
                name,
                entry.tty,
                &entry.args[..entry.args.len().min(120)]
            );
            continue;
        }

        parent_pids.insert(entry.pid, entry.ppid);

        // Get supplementary metadata from sysinfo if available
        let sysinfo_pid = sysinfo::Pid::from_u32(entry.pid);
        let (start_time, cwd) = system
            .process(sysinfo_pid)
            .map(|p| {
                (
                    p.start_time(),
                    p.cwd().map(|c| c.to_string_lossy().to_string()),
                )
            })
            .unwrap_or((0, None));

        detected.push(DetectedProcess {
            pid: entry.pid,
            name,
            cmdline: entry.args.clone(),
            start_time,
            cwd,
        });
    }

    // Deduplicate: if a process's parent is also in the detected set, remove the child.
    let detected_pids: std::collections::HashSet<u32> = detected.iter().map(|p| p.pid).collect();
    detected.retain(|proc| {
        if let Some(&ppid) = parent_pids.get(&proc.pid) {
            if detected_pids.contains(&ppid) {
                app_log_debug!(
                    debug_mode,
                    "SCANNER",
                    "dedup: pid={} is child of pid={}, skipping",
                    proc.pid,
                    ppid
                );
                return false;
            }
        }
        true
    });

    // Deduplicate GUI agents by name: Electron apps (Cursor, Windsurf) spawn
    // multiple processes with identical names that aren't parent-child related.
    // Keep only the process with the lowest PID (the main/first process).
    let mut gui_seen: std::collections::HashMap<String, u32> = std::collections::HashMap::new();
    for proc in &detected {
        if is_gui_agent(&proc.name, &proc.cmdline) {
            let lower = proc.name.to_lowercase();
            gui_seen
                .entry(lower)
                .and_modify(|min_pid| {
                    if proc.pid < *min_pid {
                        *min_pid = proc.pid;
                    }
                })
                .or_insert(proc.pid);
        }
    }
    detected.retain(|proc| {
        if is_gui_agent(&proc.name, &proc.cmdline) {
            let lower = proc.name.to_lowercase();
            if let Some(&min_pid) = gui_seen.get(&lower) {
                if proc.pid != min_pid {
                    app_log_debug!(
                        debug_mode,
                        "SCANNER",
                        "dedup GUI: pid={} name='{}' duplicate of pid={}, skipping",
                        proc.pid,
                        proc.name,
                        min_pid
                    );
                    return false;
                }
            }
        }
        true
    });

    detected
}

/// Run the process scanner as a Tokio background task.
/// Reads scan interval from shared config on each iteration,
/// allowing dynamic updates without restart.
/// Caches a `sysinfo::System` instance across iterations to avoid
/// the overhead of `System::new_all()` on every 2s scan cycle.
pub async fn run_scanner(config: Arc<RwLock<AppConfig>>, tx: mpsc::Sender<ScannerEvent>) {
    let initial_interval = config.read().await.scan_interval_ms;
    app_log!("SCANNER", "started with interval={}ms", initial_interval);
    let mut known_pids: std::collections::HashMap<u32, (AgentState, Option<String>)> =
        std::collections::HashMap::new();
    let mut system = System::new_all();

    loop {
        let cfg = config.read().await;
        let interval_ms = cfg.scan_interval_ms;
        let patterns = cfg.agent_process_patterns.clone();
        let debug_mode = cfg.debug_mode;
        let custom_keywords = cfg.custom_model_keywords.clone();
        drop(cfg);
        tokio::time::sleep(Duration::from_millis(interval_ms)).await;

        let detected = scan_processes_with_patterns(&patterns, debug_mode, Some(&mut system));
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
            let agent = process_to_agent_state(proc, &custom_keywords);
            let cwd = proc.cwd.clone();
            app_log!(
                "SCANNER",
                "new agent process: pid={} name='{}' cwd={:?}",
                proc.pid,
                proc.name,
                cwd
            );
            known_pids.insert(proc.pid, (agent.clone(), cwd.clone()));
            if tx.send(ScannerEvent::AgentFound(agent, cwd)).await.is_err() {
                app_log!("SCANNER", "channel closed, scanner stopping");
                return;
            }
        }

        // Refresh CWD for known agents that previously had cwd=None
        for proc in &detected {
            if let Some((agent, known_cwd)) = known_pids.get_mut(&proc.pid) {
                if known_cwd.is_none() {
                    if let Some(new_cwd) = &proc.cwd {
                        app_log!(
                            "SCANNER",
                            "cwd resolved: pid={} id={} cwd={}",
                            proc.pid,
                            agent.id,
                            new_cwd
                        );
                        *known_cwd = Some(new_cwd.clone());
                        if tx
                            .send(ScannerEvent::CwdUpdated(agent.id.clone(), new_cwd.clone()))
                            .await
                            .is_err()
                        {
                            app_log!("SCANNER", "channel closed, scanner stopping");
                            return;
                        }
                    }
                }
            }
        }

        // Emit AgentLost for processes that disappeared
        let lost_pids: Vec<u32> = known_pids
            .keys()
            .filter(|pid| !current_pids.contains(*pid))
            .copied()
            .collect();

        for pid in lost_pids {
            if let Some((agent, _)) = known_pids.remove(&pid) {
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
    fn test_matches_gemini_by_name() {
        assert!(matches_agent_pattern("gemini", "", BUILTIN_PATTERNS));
    }

    #[test]
    fn test_matches_node_gemini_in_cmdline() {
        assert!(matches_agent_pattern(
            "node",
            "/usr/bin/node /home/user/.nvm/gemini/bin",
            BUILTIN_PATTERNS
        ));
    }

    #[test]
    fn test_matches_codex_by_name() {
        assert!(matches_agent_pattern("codex", "", BUILTIN_PATTERNS));
    }

    #[test]
    fn test_matches_node_codex_in_cmdline() {
        assert!(matches_agent_pattern(
            "node",
            "/usr/bin/node /opt/homebrew/bin/codex",
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
            cmdline: "claude".to_string(),
            start_time: 1000,
            cwd: Some("/home/user/project".to_string()),
        };
        let agent = process_to_agent_state(&proc, &HashMap::new());
        assert_eq!(agent.pid, Some(12345));
        assert_eq!(agent.id, "pid-12345");
        assert_eq!(agent.name, "claude-12345");
        assert_eq!(agent.model, "claude");
        assert_eq!(agent.status, Status::Idle);
    }

    #[test]
    fn test_process_to_agent_state_gemini() {
        let proc = DetectedProcess {
            pid: 99999,
            name: "gemini".to_string(),
            cmdline: "gemini".to_string(),
            start_time: 1000,
            cwd: Some("/home/user/project".to_string()),
        };
        let agent = process_to_agent_state(&proc, &HashMap::new());
        assert_eq!(agent.model, "gemini");
        assert_eq!(agent.name, "gemini-99999");
    }

    #[test]
    fn test_process_to_agent_state_node_gemini() {
        let proc = DetectedProcess {
            pid: 88888,
            name: "node".to_string(),
            cmdline: "node --no-warnings=DEP0040 /opt/homebrew/bin/gemini".to_string(),
            start_time: 1000,
            cwd: Some("/home/user/project".to_string()),
        };
        let agent = process_to_agent_state(&proc, &HashMap::new());
        assert_eq!(agent.model, "gemini");
        assert_eq!(agent.name, "gemini-88888");
    }

    #[test]
    fn test_infer_initial_model() {
        let empty = HashMap::new();
        assert_eq!(infer_initial_model("claude", "", &empty), "claude");
        assert_eq!(infer_initial_model("gemini", "", &empty), "gemini");
        assert_eq!(infer_initial_model("Gemini", "", &empty), "gemini");
        assert_eq!(infer_initial_model("node-gemini", "", &empty), "gemini");
        assert_eq!(
            infer_initial_model(
                "node",
                "node --no-warnings /opt/homebrew/bin/gemini",
                &empty
            ),
            "gemini"
        );
        // Unknown processes no longer default to "claude"
        assert_eq!(infer_initial_model("node", "node", &empty), "unknown");
        assert_eq!(
            infer_initial_model("python", "python script.py", &empty),
            "unknown"
        );
        // New agent keywords
        assert_eq!(
            infer_initial_model("aider", "aider --model gpt-4", &empty),
            "aider"
        );
        assert_eq!(
            infer_initial_model("node", "node /usr/bin/cursor", &empty),
            "cursor"
        );
        assert_eq!(infer_initial_model("copilot", "", &empty), "copilot");
        // Codex
        assert_eq!(infer_initial_model("codex", "", &empty), "codex");
        assert_eq!(
            infer_initial_model("node", "node /opt/homebrew/bin/codex", &empty),
            "codex"
        );
    }

    #[test]
    fn test_infer_initial_model_custom_keywords() {
        let mut custom = HashMap::new();
        custom.insert("windsurf".to_string(), "windsurf".to_string());
        custom.insert("cody".to_string(), "cody".to_string());

        // Custom keywords match
        assert_eq!(infer_initial_model("windsurf", "", &custom), "windsurf");
        assert_eq!(
            infer_initial_model("node", "node /usr/bin/cody", &custom),
            "cody"
        );
        // Built-in still works
        assert_eq!(infer_initial_model("claude", "", &custom), "claude");
        // Unknown still returns "unknown"
        assert_eq!(
            infer_initial_model("python", "python script.py", &custom),
            "unknown"
        );
    }

    #[test]
    fn test_infer_initial_model_custom_overrides_builtin() {
        let mut custom = HashMap::new();
        // Override "claude" to map to a custom model name
        custom.insert("claude".to_string(), "my-claude-fork".to_string());

        assert_eq!(infer_initial_model("claude", "", &custom), "my-claude-fork");
    }

    #[test]
    fn test_derive_agent_name() {
        assert_eq!(derive_agent_name("claude", "claude"), "claude");
        assert_eq!(derive_agent_name("gemini", "gemini"), "gemini");
        assert_eq!(
            derive_agent_name(
                "node",
                "node --no-warnings=DEP0040 /opt/homebrew/bin/gemini"
            ),
            "gemini"
        );
        assert_eq!(
            derive_agent_name(
                "node",
                "/opt/homebrew/Cellar/node/25.7.0/bin/node --no-warnings /usr/bin/gemini"
            ),
            "gemini"
        );
        // If no script found, keep "node"
        assert_eq!(derive_agent_name("node", "node"), "node");
    }

    #[test]
    fn test_process_to_agent_state_unknown_process() {
        let proc = DetectedProcess {
            pid: 55555,
            name: "node".to_string(),
            cmdline: "node some-unknown-script.js".to_string(),
            start_time: 1000,
            cwd: None,
        };
        let agent = process_to_agent_state(&proc, &HashMap::new());
        assert_eq!(agent.model, "unknown");
    }

    #[test]
    fn test_process_to_agent_state_different_pids() {
        let proc1 = DetectedProcess {
            pid: 100,
            name: "claude".to_string(),
            cmdline: "claude".to_string(),
            start_time: 1000,
            cwd: None,
        };
        let proc2 = DetectedProcess {
            pid: 200,
            name: "claude".to_string(),
            cmdline: "claude".to_string(),
            start_time: 1000,
            cwd: None,
        };
        let agent1 = process_to_agent_state(&proc1, &HashMap::new());
        let agent2 = process_to_agent_state(&proc2, &HashMap::new());
        assert_eq!(agent1.name, "claude-100");
        assert_eq!(agent2.name, "claude-200");
    }

    #[test]
    fn test_process_to_agent_state_with_custom_keywords() {
        let mut custom = HashMap::new();
        custom.insert("windsurf".to_string(), "windsurf".to_string());

        let proc = DetectedProcess {
            pid: 42000,
            name: "windsurf".to_string(),
            cmdline: "windsurf --project /tmp".to_string(),
            start_time: 1000,
            cwd: None,
        };
        let agent = process_to_agent_state(&proc, &custom);
        assert_eq!(agent.model, "windsurf");
    }

    #[test]
    fn test_is_gui_agent() {
        assert!(is_gui_agent("Cursor", "Cursor"));
        assert!(is_gui_agent("cursor", "cursor"));
        assert!(is_gui_agent("Windsurf", "Windsurf"));
        assert!(is_gui_agent("windsurf", "windsurf"));
        assert!(is_gui_agent("node", "/Applications/Cursor.app/Contents/MacOS/Cursor"));
        assert!(!is_gui_agent("claude", "claude"));
        assert!(!is_gui_agent("node", "node script.js"));
    }

    #[test]
    fn test_cursor_helper_is_blocklisted() {
        assert!(is_blocklisted("Cursor Helper"));
        assert!(is_blocklisted("Cursor Helper (Renderer)"));
        assert!(is_blocklisted("CursorUIViewService"));
        assert!(is_blocklisted("Windsurf Helper"));
        assert!(is_blocklisted("Windsurf Helper (GPU)"));
        // Regular agents are not blocklisted
        assert!(!is_blocklisted("Cursor"));
        assert!(!is_blocklisted("Windsurf"));
    }

    #[test]
    fn test_infer_source_from_name_ide() {
        assert_eq!(infer_source_from_name("Cursor"), Source::Ide);
        assert_eq!(infer_source_from_name("cursor"), Source::Ide);
        assert_eq!(infer_source_from_name("Windsurf"), Source::Ide);
        assert_eq!(infer_source_from_name("windsurf"), Source::Ide);
        assert_eq!(infer_source_from_name("claude"), Source::Cli);
        assert_eq!(infer_source_from_name("gemini"), Source::Cli);
    }

    #[test]
    fn test_windsurf_in_model_keywords() {
        let empty = HashMap::new();
        assert_eq!(infer_initial_model("windsurf", "", &empty), "windsurf");
        assert_eq!(infer_initial_model("Windsurf", "", &empty), "windsurf");
    }

    #[test]
    fn test_process_to_agent_state_cursor_source_ide() {
        let proc = DetectedProcess {
            pid: 8115,
            name: "Cursor".to_string(),
            cmdline: "/Applications/Cursor.app/Contents/MacOS/Cursor".to_string(),
            start_time: 1000,
            cwd: None,
        };
        let agent = process_to_agent_state(&proc, &HashMap::new());
        assert_eq!(agent.model, "cursor");
        assert_eq!(agent.source, Source::Ide);
        assert_eq!(agent.name, "Cursor-8115");
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

    #[test]
    fn test_stopped_process_stat_detection() {
        // stat=T means stopped/suspended — should be filtered out
        assert!("T".starts_with('T'));
        assert!("T+".starts_with('T'));
        assert!("Ts".starts_with('T'));
        // Running/sleeping states should NOT be filtered
        assert!(!"S".starts_with('T'));
        assert!(!"S+".starts_with('T'));
        assert!(!"R".starts_with('T'));
        assert!(!"R+".starts_with('T'));
        // Zombie — not filtered by this check (handled separately if needed)
        assert!(!"Z".starts_with('T'));
    }

    #[test]
    fn test_gui_agent_dedup_by_name() {
        // Simulate multiple Cursor processes (Electron spawns several with same name)
        let procs = vec![
            DetectedProcess {
                pid: 100,
                name: "Cursor".to_string(),
                cmdline: "/Applications/Cursor.app/Contents/MacOS/Cursor".to_string(),
                start_time: 1000,
                cwd: None,
            },
            DetectedProcess {
                pid: 200,
                name: "Cursor".to_string(),
                cmdline: "/Applications/Cursor.app/Contents/MacOS/Cursor --type=gpu".to_string(),
                start_time: 1000,
                cwd: None,
            },
            DetectedProcess {
                pid: 300,
                name: "claude".to_string(),
                cmdline: "claude".to_string(),
                start_time: 1000,
                cwd: None,
            },
        ];

        // Apply GUI dedup logic
        let mut detected = procs;
        let mut gui_seen: std::collections::HashMap<String, u32> =
            std::collections::HashMap::new();
        for proc in &detected {
            if is_gui_agent(&proc.name, &proc.cmdline) {
                let lower = proc.name.to_lowercase();
                gui_seen
                    .entry(lower)
                    .and_modify(|min_pid| {
                        if proc.pid < *min_pid {
                            *min_pid = proc.pid;
                        }
                    })
                    .or_insert(proc.pid);
            }
        }
        detected.retain(|proc| {
            if is_gui_agent(&proc.name, &proc.cmdline) {
                let lower = proc.name.to_lowercase();
                if let Some(&min_pid) = gui_seen.get(&lower) {
                    return proc.pid == min_pid;
                }
            }
            true
        });

        assert_eq!(detected.len(), 2); // Cursor (pid 100) + claude (pid 300)
        assert!(detected.iter().any(|p| p.pid == 100 && p.name == "Cursor"));
        assert!(detected.iter().any(|p| p.pid == 300 && p.name == "claude"));
        assert!(!detected.iter().any(|p| p.pid == 200));
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
