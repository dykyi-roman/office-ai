// State interceptor module
// Parses agent logs and classifies states via FSM

pub mod claude_code_parser;
pub mod gemini_cli_parser;
pub mod parsed_event;
pub mod parser_registry;
pub mod parser_trait;
pub mod state_classifier;

#[allow(unused_imports)]
pub use parsed_event::ParsedEvent;
#[allow(unused_imports)]
pub use parser_trait::AgentLogParser;
