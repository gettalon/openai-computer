#!/usr/bin/env python3
import json
import select
import subprocess
from pathlib import Path

SERVER = Path(__file__).resolve().parents[1] / "skills" / "openai-computer" / "scripts" / "proxy-server.mjs"
p = subprocess.Popen(["node", str(SERVER)], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, bufsize=1)


def send(value):
    p.stdin.write(json.dumps(value) + "\n")
    p.stdin.flush()


def receive(request_id, timeout=120):
    while True:
        ready, _, _ = select.select([p.stdout], [], [], timeout)
        if not ready:
            raise TimeoutError(request_id)
        value = json.loads(p.stdout.readline())
        if value.get("id") == request_id:
            return value


try:
    send({"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"proxy-test","version":"1"}}})
    assert "result" in receive(1)
    send({"jsonrpc":"2.0","method":"notifications/initialized","params":{}})

    send({"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}})
    tools = receive(2)["result"]["tools"]
    names = {tool["name"] for tool in tools}
    assert {"js", "js_reset", "turn_ended"} <= names, names
    turn = next(tool for tool in tools if tool["name"] == "turn_ended")
    assert turn.get("_meta", {}).get("ui", {}).get("visibility") == []

    send({"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"js","arguments":{"code":"nodeRepl.write(\"GETAPP=\" + typeof cua.getApp + \" LISTAPPS=\" + typeof cua.listApps);","timeout_ms":30000,"title":"Verify computer surface"}}})
    state = receive(3)
    assert not state["result"].get("isError"), state
    text = "\n".join(x["text"] for x in state["result"]["content"] if x["type"] == "text")
    assert "GETAPP=function" in text, text[-500:]

    send({"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"turn_ended","arguments":{"hook_event_name":"Stop","session_id":"ignored-host-session","turn_id":"ignored-host-turn"}}})
    assert not receive(4)["result"].get("isError")
    print(json.dumps({"ok":True,"metadata":"synthesized","computer":True,"turnEnded":"ok"}))
finally:
    p.terminate()
    try: p.wait(timeout=10)
    except subprocess.TimeoutExpired: p.kill()
