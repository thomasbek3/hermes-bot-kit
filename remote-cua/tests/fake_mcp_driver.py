"""A stand-in for ``cua-driver mcp`` over stdio: answers initialize, tools/list and tools/call.
Every call is appended to the JSON-lines log named by argv[1]. Raw JSON-RPC, stdlib only."""
import json
import sys

LOG = sys.argv[1]
TOOLS = ["start_session", "end_session", "set_config", "set_agent_cursor_enabled", "list_windows", "click"]


def log(entry):
    with open(LOG, "a", encoding="utf-8") as fh:
        fh.write(json.dumps(entry) + "\n")


def reply(msg_id, result):
    sys.stdout.write(json.dumps({"jsonrpc": "2.0", "id": msg_id, "result": result}) + "\n")
    sys.stdout.flush()


for line in sys.stdin:
    line = line.strip()
    if not line:
        continue
    msg = json.loads(line)
    method, msg_id = msg.get("method"), msg.get("id")
    if method == "initialize":
        reply(msg_id, {"protocolVersion": msg["params"].get("protocolVersion", "2024-11-05"),
                       "capabilities": {"tools": {}}, "serverInfo": {"name": "fake-cua-driver", "version": "0.21.0"}})
    elif method == "tools/list":
        reply(msg_id, {"tools": [{"name": n, "inputSchema": {"type": "object", "properties": {}}} for n in TOOLS]})
    elif method == "tools/call":
        name, args = msg["params"]["name"], msg["params"].get("arguments") or {}
        log({"tool": name, "args": args})
        reply(msg_id, {"content": [{"type": "text", "text": json.dumps({"ok": True, "tool": name})}], "isError": False})
    elif msg_id is not None:
        reply(msg_id, {})
