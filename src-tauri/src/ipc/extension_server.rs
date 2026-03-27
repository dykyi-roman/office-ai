// HTTP server for receiving Chrome extension messages.
// Binds to 127.0.0.1:{port} and handles POST /extension.
// Bridges the native messaging host to the agent registry.

use crate::discovery::agent_registry::SharedRegistry;
use crate::models::{AgentState, AppConfig, Source, Tier};
use std::sync::Arc;
use tauri::AppHandle;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;
use tokio::sync::RwLock;

/// Envelope for messages from the native messaging host.
#[derive(serde::Deserialize, Debug)]
struct ExtensionMessage {
    #[serde(rename = "type")]
    msg_type: String,
    payload: Option<serde_json::Value>,
}

/// Payload for agent:lost messages.
#[derive(serde::Deserialize, Debug)]
struct AgentLostPayload {
    id: String,
}

const HTTP_200: &[u8] = b"HTTP/1.1 200 OK\r\nContent-Length: 0\r\nConnection: close\r\n\r\n";
const HTTP_400: &[u8] =
    b"HTTP/1.1 400 Bad Request\r\nContent-Length: 0\r\nConnection: close\r\n\r\n";
const HTTP_404: &[u8] = b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n";
const HTTP_405: &[u8] =
    b"HTTP/1.1 405 Method Not Allowed\r\nContent-Length: 0\r\nConnection: close\r\n\r\n";

/// Start the HTTP server for receiving Chrome extension messages.
pub async fn run_extension_server(
    port: u16,
    registry: SharedRegistry,
    config: Arc<RwLock<AppConfig>>,
    handle: AppHandle,
) {
    let addr = format!("127.0.0.1:{}", port);
    let listener = match TcpListener::bind(&addr).await {
        Ok(l) => {
            app_log!("EXT_SERVER", "listening on {}", addr);
            l
        }
        Err(e) => {
            app_log!("EXT_SERVER", "failed to bind {}: {}", addr, e);
            return;
        }
    };

    loop {
        let (stream, peer) = match listener.accept().await {
            Ok(conn) => conn,
            Err(e) => {
                app_log!("EXT_SERVER", "accept error: {}", e);
                continue;
            }
        };

        let registry = Arc::clone(&registry);
        let config = Arc::clone(&config);
        let handle = handle.clone();

        tokio::spawn(async move {
            if let Err(e) = handle_connection(stream, &registry, &config, &handle).await {
                app_log!("EXT_SERVER", "connection from {} error: {}", peer, e);
            }
        });
    }
}

/// Parse one HTTP request from the stream and dispatch it.
async fn handle_connection(
    mut stream: tokio::net::TcpStream,
    registry: &SharedRegistry,
    config: &Arc<RwLock<AppConfig>>,
    handle: &AppHandle,
) -> Result<(), String> {
    // Read up to 64KB — more than enough for any agent state message
    let mut buf = vec![0u8; 65536];
    let mut total = 0;

    // Read until we have complete headers + body
    loop {
        if total >= buf.len() {
            let _ = stream.write_all(HTTP_400).await;
            return Err("request too large".to_string());
        }
        let n = stream
            .read(&mut buf[total..])
            .await
            .map_err(|e| e.to_string())?;
        if n == 0 {
            return Err("connection closed before complete request".to_string());
        }
        total += n;

        // Check if we have the full request
        let data = &buf[..total];
        if let Some(header_end) = find_header_end(data) {
            let headers = &data[..header_end];
            let content_length = parse_content_length(headers);
            let body_start = header_end + 4; // past \r\n\r\n
            let body_received = total - body_start;

            if body_received >= content_length {
                // We have the full request — parse and dispatch
                let (method, path) = parse_request_line(headers)?;
                let body = &data[body_start..body_start + content_length];

                let response = dispatch(&method, &path, body, registry, config, handle).await;
                let _ = stream.write_all(response).await;
                return Ok(());
            }
            // Need more body bytes — continue reading
        }
        // Need more header bytes — continue reading
    }
}

/// Find the position of \r\n\r\n in the buffer (returns position of first \r).
fn find_header_end(data: &[u8]) -> Option<usize> {
    data.windows(4).position(|w| w == b"\r\n\r\n")
}

/// Extract Content-Length from raw headers. Returns 0 if not found.
fn parse_content_length(headers: &[u8]) -> usize {
    let text = String::from_utf8_lossy(headers);
    for line in text.lines() {
        if let Some(val) = line.strip_prefix("Content-Length:") {
            if let Ok(n) = val.trim().parse::<usize>() {
                return n;
            }
        }
        // Case-insensitive fallback
        if line.len() > 15 && line[..15].eq_ignore_ascii_case("content-length:") {
            if let Ok(n) = line[15..].trim().parse::<usize>() {
                return n;
            }
        }
    }
    0
}

/// Parse the HTTP request line (e.g. "POST /extension HTTP/1.1").
fn parse_request_line(headers: &[u8]) -> Result<(String, String), String> {
    let text = String::from_utf8_lossy(headers);
    let first_line = text.lines().next().ok_or("empty request")?;
    let parts: Vec<&str> = first_line.split_whitespace().collect();
    if parts.len() < 2 {
        return Err("malformed request line".to_string());
    }
    Ok((parts[0].to_string(), parts[1].to_string()))
}

/// Route the request to the appropriate handler.
async fn dispatch(
    method: &str,
    path: &str,
    body: &[u8],
    registry: &SharedRegistry,
    config: &Arc<RwLock<AppConfig>>,
    handle: &AppHandle,
) -> &'static [u8] {
    if path != "/extension" {
        return HTTP_404;
    }
    if method != "POST" {
        return HTTP_405;
    }

    let message: ExtensionMessage = match serde_json::from_slice(body) {
        Ok(m) => m,
        Err(e) => {
            app_log!("EXT_SERVER", "JSON parse error: {}", e);
            return HTTP_400;
        }
    };

    match message.msg_type.as_str() {
        "agent:state" => handle_agent_state(message.payload, registry, config, handle).await,
        "agent:lost" => handle_agent_lost(message.payload, registry, handle).await,
        "heartbeat" => HTTP_200,
        _ => {
            app_log!("EXT_SERVER", "unknown message type: {}", message.msg_type);
            HTTP_400
        }
    }
}

/// Process an agent:state message — register or update the agent.
async fn handle_agent_state(
    payload: Option<serde_json::Value>,
    registry: &SharedRegistry,
    config: &Arc<RwLock<AppConfig>>,
    handle: &AppHandle,
) -> &'static [u8] {
    let value = match payload {
        Some(v) => v,
        None => {
            app_log!("EXT_SERVER", "agent:state missing payload");
            return HTTP_400;
        }
    };

    let mut agent: AgentState = match serde_json::from_value(value) {
        Ok(a) => a,
        Err(e) => {
            app_log!("EXT_SERVER", "agent:state parse error: {}", e);
            return HTTP_400;
        }
    };

    // Re-derive tier from model on the server side for consistency
    agent.tier = Tier::from_model(&agent.model);
    // Ensure source is correct
    agent.source = Source::BrowserExtension;

    let mut reg = registry.write().await;
    let max = config.read().await.max_agents;

    if let Some(mut existing) = reg.get(&agent.id) {
        // Update existing agent — preserve startedAt and accumulate tokens
        agent.started_at = existing.started_at.clone();
        if agent.tokens_in == 0 && existing.tokens_in > 0 {
            agent.tokens_in = existing.tokens_in;
        }
        if agent.tokens_out == 0 && existing.tokens_out > 0 {
            agent.tokens_out = existing.tokens_out;
        }
        // Preserve sub_agents from existing if not provided
        if agent.sub_agents.is_empty() && !existing.sub_agents.is_empty() {
            agent.sub_agents = existing.sub_agents.clone();
        }
        existing = agent;
        let id = existing.id.clone();
        app_log!(
            "EXT_SERVER",
            "update agent {} status={:?}",
            id,
            existing.status
        );
        reg.update(&id, existing, handle);
    } else if reg.len() < max as usize {
        // New agent within limit
        app_log!(
            "EXT_SERVER",
            "register agent {} name='{}' model='{}'",
            agent.id,
            agent.name,
            agent.model
        );
        reg.register(agent, handle);
    } else {
        app_log!(
            "EXT_SERVER",
            "agent {} rejected (limit {} reached)",
            agent.id,
            max
        );
    }

    HTTP_200
}

/// Process an agent:lost message — remove the agent from the registry.
async fn handle_agent_lost(
    payload: Option<serde_json::Value>,
    registry: &SharedRegistry,
    handle: &AppHandle,
) -> &'static [u8] {
    let value = match payload {
        Some(v) => v,
        None => {
            app_log!("EXT_SERVER", "agent:lost missing payload");
            return HTTP_400;
        }
    };

    let lost: AgentLostPayload = match serde_json::from_value(value) {
        Ok(l) => l,
        Err(e) => {
            app_log!("EXT_SERVER", "agent:lost parse error: {}", e);
            return HTTP_400;
        }
    };

    let mut reg = registry.write().await;
    app_log!("EXT_SERVER", "remove agent {}", lost.id);
    reg.remove(&lost.id, handle);
    HTTP_200
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_find_header_end() {
        let data = b"POST /extension HTTP/1.1\r\nContent-Length: 5\r\n\r\nhello";
        assert_eq!(find_header_end(data), Some(43));
    }

    #[test]
    fn test_find_header_end_not_found() {
        let data = b"POST /extension HTTP/1.1\r\nContent-Length: 5\r\n";
        assert_eq!(find_header_end(data), None);
    }

    #[test]
    fn test_parse_content_length() {
        let headers = b"POST /extension HTTP/1.1\r\nContent-Length: 42\r\n";
        assert_eq!(parse_content_length(headers), 42);
    }

    #[test]
    fn test_parse_content_length_missing() {
        let headers = b"POST /extension HTTP/1.1\r\nHost: localhost\r\n";
        assert_eq!(parse_content_length(headers), 0);
    }

    #[test]
    fn test_parse_content_length_case_insensitive() {
        let headers = b"POST /extension HTTP/1.1\r\ncontent-length: 99\r\n";
        assert_eq!(parse_content_length(headers), 99);
    }

    #[test]
    fn test_parse_request_line() {
        let headers = b"POST /extension HTTP/1.1\r\nHost: localhost\r\n";
        let (method, path) = parse_request_line(headers).unwrap();
        assert_eq!(method, "POST");
        assert_eq!(path, "/extension");
    }

    #[test]
    fn test_parse_request_line_get() {
        let headers = b"GET /health HTTP/1.1\r\n";
        let (method, path) = parse_request_line(headers).unwrap();
        assert_eq!(method, "GET");
        assert_eq!(path, "/health");
    }

    #[test]
    fn test_parse_request_line_malformed() {
        let headers = b"INVALID\r\n";
        assert!(parse_request_line(headers).is_err());
    }

    #[test]
    fn test_extension_message_deserialize_agent_state() {
        let json = r#"{"type":"agent:state","payload":{"id":"browser-chatgpt-abc123","pid":null,"name":"ChatGPT","model":"GPT-4o","tier":"expert","role":"agent","status":"thinking","idleLocation":"desk","currentTask":"Processing prompt","tokensIn":0,"tokensOut":0,"subAgents":[],"lastActivity":"2026-03-23T10:00:00Z","startedAt":"2026-03-23T09:00:00Z","source":"browser_extension"}}"#;
        let msg: ExtensionMessage = serde_json::from_str(json).unwrap();
        assert_eq!(msg.msg_type, "agent:state");
        assert!(msg.payload.is_some());

        let agent: AgentState = serde_json::from_value(msg.payload.unwrap()).unwrap();
        assert_eq!(agent.id, "browser-chatgpt-abc123");
        assert_eq!(agent.pid, None);
        assert_eq!(agent.source, Source::BrowserExtension);
    }

    #[test]
    fn test_extension_message_deserialize_agent_lost() {
        let json = r#"{"type":"agent:lost","payload":{"id":"browser-chatgpt-abc123"}}"#;
        let msg: ExtensionMessage = serde_json::from_str(json).unwrap();
        assert_eq!(msg.msg_type, "agent:lost");

        let lost: AgentLostPayload = serde_json::from_value(msg.payload.unwrap()).unwrap();
        assert_eq!(lost.id, "browser-chatgpt-abc123");
    }

    #[test]
    fn test_extension_message_deserialize_heartbeat() {
        let json = r#"{"type":"heartbeat","payload":null}"#;
        let msg: ExtensionMessage = serde_json::from_str(json).unwrap();
        assert_eq!(msg.msg_type, "heartbeat");
    }
}
