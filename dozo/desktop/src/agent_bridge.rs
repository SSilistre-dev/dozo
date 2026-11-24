//! The bot's tools, for an agent on this computer: the program the agent starts as its MCP server
//! (`device_agent.rs` names it in `session/new`) is this app's own, started with
//! `--dozo-agent-bridge` before anything else of the app runs. It only relays: the agent's tool
//! lists and calls go as lines over the Unix socket named by `DOZO_BRIDGE_SOCKET`, each with
//! `DOZO_BRIDGE_KEY`, to the app that started the agent, which asks the server for the bot's
//! tools. The line protocol is the same one the server's own bridge speaks
//! (`packages/adapters/src/cli-models/dozo-agent-bridge.ts`), and so is the MCP side.

use std::io::{BufRead, BufReader, Write};
use std::os::unix::net::UnixStream;
use std::sync::mpsc;

use serde_json::{Value, json};

pub const FLAG: &str = "--dozo-agent-bridge";

/// What `main` calls when the program was started with `FLAG`. Never returns: it ends with the
/// agent's input or with the socket.
pub fn main() -> ! {
    let (Ok(path), Ok(key)) = (
        std::env::var("DOZO_BRIDGE_SOCKET"),
        std::env::var("DOZO_BRIDGE_KEY"),
    ) else {
        std::process::exit(1);
    };
    let Ok(socket) = UnixStream::connect(path) else {
        std::process::exit(1);
    };
    serve(
        std::io::stdin().lock(),
        std::io::stdout(),
        socket,
        &key,
        Box::new(|| std::process::exit(0)),
    );
    std::process::exit(0);
}

/// Answers the agent's MCP requests (a message per line on `input`, answers on `output`) until
/// `input` ends. `closed` runs when the socket does.
pub fn serve(
    input: impl BufRead,
    mut output: impl Write,
    socket: UnixStream,
    key: &str,
    closed: Box<dyn Fn() + Send>,
) {
    let (replies, answers) = mpsc::channel::<Value>();
    let Ok(reading) = socket.try_clone() else {
        return;
    };
    std::thread::spawn(move || {
        for line in BufReader::new(reading).lines() {
            let Ok(line) = line else { break };
            if let Ok(reply) = serde_json::from_str::<Value>(&line)
                && replies.send(reply).is_err()
            {
                break;
            }
        }
        closed();
    });
    let mut writing = socket;
    let mut next = 0u64;
    // One message at a time, as the server's own bridge does: a call holds the loop until answered.
    let mut ask = |mut message: Value| -> Option<Value> {
        next += 1;
        message["id"] = json!(next);
        message["key"] = json!(key);
        writeln!(writing, "{message}").ok()?;
        loop {
            let reply = answers.recv().ok()?;
            if reply["id"] == json!(next) {
                return Some(reply);
            }
        }
    };
    let mut send = |message: Value| {
        let mut message = message;
        message["jsonrpc"] = json!("2.0");
        let _ = writeln!(output, "{message}");
        let _ = output.flush();
    };
    for line in input.lines() {
        let Ok(line) = line else { break };
        let Ok(request) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        let Some(id) = request.get("id").filter(|id| !id.is_null()).cloned() else {
            continue;
        };
        let params = request.get("params").cloned().unwrap_or(Value::Null);
        match request.get("method").and_then(Value::as_str) {
            Some("initialize") => send(json!({ "id": id, "result": {
                "protocolVersion": params.get("protocolVersion").cloned()
                    .unwrap_or_else(|| json!("2025-06-18")),
                "capabilities": { "tools": {} },
                "serverInfo": { "name": "dozo", "version": "1" },
            } })),
            Some("tools/list") => {
                let tools = ask(json!({ "method": "list" }))
                    .and_then(|reply| reply.get("tools").cloned())
                    .unwrap_or_else(|| json!([]));
                send(json!({ "id": id, "result": { "tools": tools } }));
            }
            Some("tools/call") => {
                let arguments = params
                    .get("arguments")
                    .cloned()
                    .unwrap_or_else(|| json!({}));
                let reply = ask(json!({ "method": "call",
                    "name": params.get("name").cloned().unwrap_or(Value::Null),
                    "arguments": arguments }));
                let (text, is_error) = match &reply {
                    Some(reply) => (
                        match reply.get("text") {
                            Some(Value::String(text)) => text.clone(),
                            Some(Value::Null) | None => String::new(),
                            Some(other) => other.to_string(),
                        },
                        reply
                            .get("isError")
                            .is_some_and(|flag| flag == &json!(true)),
                    ),
                    None => ("Dozo's tools are not reachable.".to_owned(), true),
                };
                send(json!({ "id": id, "result": {
                    "content": [{ "type": "text", "text": text }], "isError": is_error } }));
            }
            Some("ping") => send(json!({ "id": id, "result": {} })),
            _ => send(json!({ "id": id,
                "error": { "code": -32601, "message": "Method not found" } })),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{Value, json};
    use std::io::{BufRead, BufReader, Cursor, Write};
    use std::sync::{Arc, Mutex, mpsc};

    #[derive(Clone, Default)]
    struct Sink(Arc<Mutex<Vec<u8>>>);
    impl Write for Sink {
        fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
            self.0.lock().unwrap().extend_from_slice(bytes);
            Ok(bytes.len())
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }

    /// The server side of the bridge's socket: answers `list` and `call` as the app does, and
    /// reports each message it saw, so the test can check the key rode along.
    fn server(socket: UnixStream, key: &'static str) -> (mpsc::Receiver<Value>, UnixStream) {
        let (seen, seen_rx) = mpsc::channel();
        let control = socket.try_clone().unwrap();
        std::thread::spawn(move || {
            let mut out = socket.try_clone().unwrap();
            for line in BufReader::new(socket).lines() {
                let message: Value = serde_json::from_str(&line.unwrap()).unwrap();
                assert_eq!(message["key"], key);
                let reply = match message["method"].as_str() {
                    Some("list") => json!({ "id": message["id"], "tools": [
                        { "name": "t", "description": "d", "inputSchema": { "type": "object" } }] }),
                    _ => json!({ "id": message["id"],
                        "text": format!("ran {} {}", message["name"], message["arguments"]),
                        "isError": message["name"] == "bad" }),
                };
                let _ = seen.send(message);
                writeln!(out, "{reply}").unwrap();
            }
        });
        (seen_rx, control)
    }

    fn lines(requests: &[Value]) -> Cursor<Vec<u8>> {
        let text: String = requests.iter().map(|r| format!("{r}\n")).collect();
        Cursor::new(text.into_bytes())
    }

    #[test]
    fn it_speaks_mcp_on_stdio_and_relays_to_the_socket() {
        let (ours, theirs) = UnixStream::pair().unwrap();
        let (seen, control) = server(theirs, "k".repeat(64).leak());
        let out = Sink::default();
        let (closed, closed_rx) = mpsc::channel();
        let requests = [
            json!({ "jsonrpc": "2.0", "id": 1, "method": "initialize",
                "params": { "protocolVersion": "2025-03-26" } }),
            json!({ "jsonrpc": "2.0", "method": "notifications/initialized" }),
            json!({ "jsonrpc": "2.0", "id": 2, "method": "tools/list" }),
            json!({ "jsonrpc": "2.0", "id": 3, "method": "tools/call",
                "params": { "name": "t", "arguments": { "a": 1 } } }),
            json!({ "jsonrpc": "2.0", "id": 4, "method": "tools/call", "params": { "name": "bad" } }),
            json!({ "jsonrpc": "2.0", "id": 5, "method": "ping" }),
            json!({ "jsonrpc": "2.0", "id": 6, "method": "resources/list" }),
        ];
        serve(
            lines(&requests),
            out.clone(),
            ours,
            &"k".repeat(64),
            Box::new(move || {
                let _ = closed.send(());
            }),
        );
        let replies: Vec<Value> = String::from_utf8(out.0.lock().unwrap().clone())
            .unwrap()
            .lines()
            .map(|line| serde_json::from_str(line).unwrap())
            .collect();
        assert_eq!(replies.len(), 6, "{replies:?}");
        assert!(replies.iter().all(|reply| reply["jsonrpc"] == "2.0"));
        assert_eq!(
            replies[0]["result"],
            json!({ "protocolVersion": "2025-03-26",
            "capabilities": { "tools": {} }, "serverInfo": { "name": "dozo", "version": "1" } })
        );
        assert_eq!(replies[1]["result"]["tools"][0]["name"], "t");
        assert_eq!(replies[2]["id"], 3);
        assert_eq!(
            replies[2]["result"],
            json!({ "content": [
            { "type": "text", "text": "ran \"t\" {\"a\":1}" }], "isError": false })
        );
        assert_eq!(replies[3]["result"]["isError"], true);
        assert_eq!(replies[4]["result"], json!({}));
        assert_eq!(
            replies[5]["error"],
            json!({ "code": -32601, "message": "Method not found" })
        );
        // Two lists and calls went over the socket, each with the key; the rest never did.
        let methods: Vec<_> = seen
            .try_iter()
            .map(|m| m["method"].as_str().unwrap().to_owned())
            .collect();
        assert_eq!(methods, ["list", "call", "call"]);
        // The socket closing ends the bridge.
        control.shutdown(std::net::Shutdown::Both).unwrap();
        assert!(
            closed_rx
                .recv_timeout(std::time::Duration::from_secs(5))
                .is_ok()
        );
    }

    #[test]
    fn a_line_that_is_not_json_is_skipped() {
        let (ours, _theirs) = UnixStream::pair().unwrap();
        let out = Sink::default();
        let input =
            Cursor::new(b"not json\n{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"ping\"}\n".to_vec());
        serve(input, out.clone(), ours, "k", Box::new(|| {}));
        let text = String::from_utf8(out.0.lock().unwrap().clone()).unwrap();
        assert_eq!(text.lines().count(), 1);
    }
}
