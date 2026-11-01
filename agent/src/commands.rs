//! Server commands (start / pause / stop) and the agent state machine.

use serde::Deserialize;
use std::collections::{HashSet, VecDeque};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AgentState {
    Mining,
    Paused,
    Stopped,
}

impl AgentState {
    pub fn label(self) -> &'static str {
        match self {
            AgentState::Mining => "mining",
            AgentState::Paused => "paused",
            AgentState::Stopped => "stopped",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Command {
    Start,
    Pause,
    Stop,
}

impl Command {
    pub fn parse(s: &str) -> Option<Command> {
        match s {
            "start" => Some(Command::Start),
            "pause" => Some(Command::Pause),
            "stop" => Some(Command::Stop),
            _ => None,
        }
    }

    pub fn target_state(self) -> AgentState {
        match self {
            Command::Start => AgentState::Mining,
            Command::Pause => AgentState::Paused,
            Command::Stop => AgentState::Stopped,
        }
    }
}

/// One entry of `GET /v1/commands` (`{commands: [{id, command, created_at, expires_at}]}`); extra fields are ignored.
#[derive(Clone, Debug, Deserialize, PartialEq, Eq)]
pub struct ServerCommand {
    pub id: String,
    pub command: String,
}

#[derive(Debug, Deserialize)]
pub struct CommandsResponse {
    pub commands: Vec<ServerCommand>,
}

/// Remembers recently handled command ids so a re-delivery (e.g. our ack was lost) is acked again but not re-applied.
#[derive(Debug, Default)]
pub struct HandledIds {
    order: VecDeque<String>,
    set: HashSet<String>,
}

impl HandledIds {
    const CAP: usize = 256;

    pub fn contains(&self, id: &str) -> bool {
        self.set.contains(id)
    }

    pub fn insert(&mut self, id: &str) {
        if self.set.insert(id.to_string()) {
            self.order.push_back(id.to_string());
            if self.order.len() > Self::CAP {
                if let Some(old) = self.order.pop_front() {
                    self.set.remove(&old);
                }
            }
        }
    }
}

/// What to do about a batch of commands, in order.
#[derive(Debug, PartialEq, Eq)]
pub struct Plan {
    /// Commands to apply now, oldest first: `(id, command)`.
    pub apply: Vec<(String, Command)>,
    /// Already handled earlier: ack again, do not re-apply.
    pub reack: Vec<String>,
    /// Commands this agent version does not understand: not applied, not acked.
    pub unknown: Vec<(String, String)>,
}

pub fn plan(cmds: &[ServerCommand], handled: &HandledIds) -> Plan {
    let mut p = Plan { apply: vec![], reack: vec![], unknown: vec![] };
    for c in cmds {
        if handled.contains(&c.id) {
            p.reack.push(c.id.clone());
        } else if let Some(cmd) = Command::parse(&c.command) {
            p.apply.push((c.id.clone(), cmd));
        } else {
            p.unknown.push((c.id.clone(), c.command.chars().take(32).collect()));
        }
    }
    p
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sc(id: &str, c: &str) -> ServerCommand {
        ServerCommand { id: id.into(), command: c.into() }
    }

    #[test]
    fn parses_the_three_known_commands_only() {
        assert_eq!(Command::parse("start"), Some(Command::Start));
        assert_eq!(Command::parse("pause"), Some(Command::Pause));
        assert_eq!(Command::parse("stop"), Some(Command::Stop));
        for bad in ["", "START", "restart", "rm -rf /", "pause ", "exec"] {
            assert_eq!(Command::parse(bad), None, "{bad:?}");
        }
    }

    #[test]
    fn commands_map_to_states() {
        assert_eq!(Command::Start.target_state(), AgentState::Mining);
        assert_eq!(Command::Pause.target_state(), AgentState::Paused);
        assert_eq!(Command::Stop.target_state(), AgentState::Stopped);
    }

    #[test]
    fn plan_keeps_order_skips_handled_and_never_applies_unknown() {
        let mut handled = HandledIds::default();
        handled.insert("b");
        let p = plan(&[sc("a", "pause"), sc("b", "start"), sc("c", "selfdestruct"), sc("d", "stop")], &handled);
        assert_eq!(p.apply, vec![("a".to_string(), Command::Pause), ("d".to_string(), Command::Stop)]);
        assert_eq!(p.reack, vec!["b".to_string()]);
        assert_eq!(p.unknown, vec![("c".to_string(), "selfdestruct".to_string())]);
    }

    #[test]
    fn handled_ids_are_bounded() {
        let mut h = HandledIds::default();
        for i in 0..1000 {
            h.insert(&i.to_string());
        }
        assert!(!h.contains("0") && h.contains("999"));
        assert!(h.set.len() <= HandledIds::CAP);
    }

    #[test]
    fn parses_server_response_shape() {
        let r: CommandsResponse = serde_json::from_str(
            r#"{"commands":[{"id":"11111111-2222-4333-8444-555555555555","command":"pause","created_at":"2026-10-31T20:00:00Z","expires_at":"2026-10-31T21:00:00Z"}]}"#,
        )
        .unwrap();
        assert_eq!(r.commands[0].command, "pause");
    }
}
