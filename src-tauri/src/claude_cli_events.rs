//! Conversion of Claude Code stream-json events into NextChat driver events.
use serde_json::{json, Value};

#[derive(Default)]
pub struct ClaudeEvents {
    pub text: String,
    pub succeeded: bool,
    saw_stream: bool,
    assistant_stream: bool,
    separate_text: bool,
}

impl ClaudeEvents {
    fn append_text(&mut self, chunk: &str, out: &mut Vec<Value>) {
        if chunk.is_empty() {
            return;
        }
        let separator =
            if self.separate_text && !self.text.is_empty() && !self.text.ends_with("\n\n") {
                if self.text.ends_with('\n') {
                    "\n"
                } else {
                    "\n\n"
                }
            } else {
                ""
            };
        self.separate_text = false;
        let value = format!("{separator}{chunk}");
        self.text.push_str(&value);
        out.push(json!({"type": "text", "text": value}));
    }

    pub fn accept(&mut self, event: &Value, secret: &str) -> Result<Vec<Value>, String> {
        let mut out = Vec::new();
        let kind = event["type"].as_str().unwrap_or("");
        let nested = !event["parent_tool_use_id"].is_null();
        match kind {
            "stream_event" if !nested => {
                let part = &event["event"];
                if part["type"] == "message_start" {
                    self.assistant_stream = false;
                    self.separate_text = !self.text.is_empty();
                } else if part["type"] == "content_block_delta" {
                    match part["delta"]["type"].as_str() {
                        Some("text_delta") => {
                            self.saw_stream = true;
                            self.assistant_stream = true;
                            self.append_text(
                                part["delta"]["text"].as_str().unwrap_or(""),
                                &mut out,
                            );
                        }
                        Some("thinking_delta") => {
                            out.push(json!({"type": "thinking", "text": part["delta"]["thinking"].as_str().unwrap_or("")}));
                        }
                        _ => {}
                    }
                }
            }
            "assistant" if !nested => {
                if let Some(parts) = event["message"]["content"].as_array() {
                    for part in parts {
                        match part["type"].as_str() {
                            Some("text") if !self.assistant_stream => self.append_text(part["text"].as_str().unwrap_or(""), &mut out),
                            Some("tool_use") => out.push(json!({"type": "tool_start", "id": part["id"], "name": part["name"], "input": part["input"]})),
                            _ => {}
                        }
                    }
                }
                self.separate_text = !self.text.is_empty();
            }
            "user" if !nested => {
                if let Some(parts) = event["message"]["content"].as_array() {
                    for part in parts {
                        if part["type"] == "tool_result" {
                            let content = part["content"]
                                .as_str()
                                .map(str::to_owned)
                                .unwrap_or_else(|| part["content"].to_string());
                            out.push(json!({"type": "tool_end", "id": part["tool_use_id"], "content": content, "isError": part["is_error"].as_bool().unwrap_or(false)}));
                        }
                    }
                }
            }
            "result" => {
                if event["is_error"].as_bool().unwrap_or(false) || event["subtype"] != "success" {
                    let subtype: String = event["subtype"]
                        .as_str()
                        .unwrap_or("unknown")
                        .chars()
                        .filter(|c| c.is_ascii_alphanumeric() || *c == '_' || *c == '-')
                        .collect();
                    let message = event["errors"]
                        .as_array()
                        .map(|errors| {
                            errors
                                .iter()
                                .filter_map(Value::as_str)
                                .collect::<Vec<_>>()
                                .join("\n")
                        })
                        .filter(|text| !text.is_empty())
                        .or_else(|| event["result"].as_str().map(str::to_owned))
                        .unwrap_or_else(|| "Request failed".into());
                    return Err(format!(
                        "Claude Code failed ({subtype}): {}",
                        redact(&message, secret)
                    ));
                }
                if !self.saw_stream && self.text.is_empty() {
                    if let Some(result) = event["result"].as_str() {
                        self.text = result.into();
                        out.push(json!({"type": "text", "text": result}));
                    }
                }
                self.succeeded = true;
            }
            _ => {}
        }
        Ok(out)
    }
}

pub fn redact(value: &str, secret: &str) -> String {
    let value = if secret.is_empty() {
        value.to_owned()
    } else {
        value.replace(secret, "[REDACTED]")
    };
    let mut result = String::new();
    let mut cursor = 0;
    let lowercase = value.to_ascii_lowercase();
    while let Some(relative) = lowercase[cursor..].find("bearer ") {
        let start = cursor + relative;
        let token_start = start + 7;
        result.push_str(&value[cursor..token_start]);
        let end = value[token_start..]
            .find(|c: char| c.is_whitespace() || c == '\'' || c == '"')
            .map(|offset| token_start + offset)
            .unwrap_or(value.len());
        result.push_str("[REDACTED]");
        cursor = end;
    }
    result.push_str(&value[cursor..]);
    result.chars().take(2000).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn converts_partial_text_thinking_tools_and_segment_spacing() {
        let mut parser = ClaudeEvents::default();
        let input = [
            json!({"type":"stream_event","event":{"type":"message_start"}}),
            json!({"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"thinking_delta","thinking":"think"}}}),
            json!({"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"before"}}}),
            json!({"type":"assistant","message":{"content":[{"type":"text","text":"before"},{"type":"tool_use","id":"t","name":"probe","input":{"x":1}}]}}),
            json!({"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"t","content":"ok"}]}}),
            json!({"type":"stream_event","event":{"type":"message_start"}}),
            json!({"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"after"}}}),
            json!({"type":"result","subtype":"success"}),
        ];
        let output: Vec<Value> = input
            .iter()
            .flat_map(|event| parser.accept(event, "key").unwrap())
            .collect();
        assert_eq!(parser.text, "before\n\nafter");
        assert!(parser.succeeded);
        assert_eq!(
            output
                .iter()
                .filter(|event| event["type"] == "thinking")
                .count(),
            1
        );
        assert_eq!(
            output
                .iter()
                .filter(|event| event["type"] == "tool_start")
                .count(),
            1
        );
        assert_eq!(
            output
                .iter()
                .filter(|event| event["type"] == "tool_end")
                .count(),
            1
        );
    }
    #[test]
    fn failure_masks_gateway_and_bearer_secrets() {
        let mut parser = ClaudeEvents::default();
        let error = parser
            .accept(
                &json!({"type":"result","subtype":"error","result":"key123 Bearer other-token"}),
                "key123",
            )
            .unwrap_err();
        assert!(!error.contains("key123"));
        assert!(!error.contains("other-token"));
    }
}
