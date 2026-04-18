#!/usr/bin/env python3
"""
Smithers telemetry listener — on-demand via Matrix room message polling.

Polls the dashboard room for "!telemetry" commands using /messages (not /sync).
When a command is found that hasn't been responded to yet, collects stats and
posts them back. Otherwise completely quiescent.

Uses /messages instead of /sync to avoid sync-position conflicts with the
dashboard client (both share the same access token).
"""

import json
import os
import sys
import time
import subprocess
import urllib.request
import urllib.parse

HS = os.environ.get("MATRIX_HOMESERVER", "").strip()
TOKEN = os.environ.get("MATRIX_ACCESS_TOKEN", "").strip()
ROOM_ID = os.environ.get("SMITHERS_DASHBOARD_ROOM", "!KBLhManwDt1zUJ3DRw:a8629a1195ecb53afe1700cd3bafda1d18d9635d-6167.dstack-pha-prod7.phala.network")

POLL_INTERVAL = 5  # seconds between polls
BACKLOG_CHECK = 10  # how many recent messages to check


def get_stats():
    """Collect system stats from /proc and standard tools."""
    with open("/proc/stat") as f:
        line1 = f.readline().split()
    time.sleep(0.5)
    with open("/proc/stat") as f:
        line2 = f.readline().split()

    idle1, idle2 = int(line1[4]), int(line2[4])
    total1 = sum(int(x) for x in line1[1:])
    total2 = sum(int(x) for x in line2[1:])
    cpu_pct = (1.0 - (idle2 - idle1) / max(total2 - total1, 1)) * 100

    mem = {}
    with open("/proc/meminfo") as f:
        for line in f:
            parts = line.split()
            mem[parts[0].rstrip(":")] = int(parts[1])

    mem_total_mb = mem["MemTotal"] / 1024
    mem_available_mb = mem["MemAvailable"] / 1024
    mem_used_pct = ((mem["MemTotal"] - mem["MemAvailable"]) / mem["MemTotal"]) * 100

    with open("/proc/loadavg") as f:
        load = f.read().split()

    with open("/proc/uptime") as f:
        uptime_hours = float(f.read().split()[0]) / 3600

    df = subprocess.run(["df", "-h", "/"], capture_output=True, text=True).stdout.split("\n")
    if len(df) >= 2:
        parts = df[1].split()
        disk_used, disk_total, disk_pct = parts[2], parts[1], parts[4].rstrip("%")
    else:
        disk_used = disk_total = disk_pct = "?"

    net_rx = net_tx = 0
    with open("/proc/net/dev") as f:
        for line in f:
            if ": " not in line:
                continue
            iface, data = line.split(":")
            if iface.strip() == "lo":
                continue
            parts = data.split()
            net_rx += int(parts[0])
            net_tx += int(parts[8])
            break

    return (
        f"[Smithers] CVM Telemetry | "
        f"CPU: {cpu_pct:.1f}% | "
        f"Mem: {mem_available_mb:.0f}/{mem_total_mb:.0f} MB ({mem_used_pct:.1f}%) | "
        f"Load: {load[0]} | "
        f"Uptime: {uptime_hours:.1f}h | "
        f"Disk: {disk_used}/{disk_total} ({disk_pct}%) | "
        f"Net RX: {net_rx/1024/1024:.1f} MB TX: {net_tx/1024/1024:.1f} MB"
    )


def matrix_api(method, path, data=None, timeout=10):
    """Make a Matrix client API call."""
    url = f"{HS}/_matrix/client/v3{path}"
    body = json.dumps(data).encode() if data else None
    req = urllib.request.Request(url, data=body, method=method)
    req.add_header("Authorization", f"Bearer {TOKEN}")
    req.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return json.loads(resp.read())
    except urllib.error.HTTPError as e:
        err_body = e.read().decode()
        print(f"API error {e.code}: {err_body}", file=sys.stderr)
        return None
    except Exception as e:
        print(f"API call failed: {e}", file=sys.stderr)
        return None


def post_message(body_text):
    """Post a message to the room."""
    txn_id = f"telem-{int(time.time()*1000)}"
    result = matrix_api("PUT", f"/rooms/{ROOM_ID}/send/m.room.message/{txn_id}", {
        "msgtype": "m.text",
        "body": body_text,
    })
    return result.get("event_id") if result else None


def get_recent_messages(since_token=None):
    """Fetch recent messages from the room via /messages."""
    params = {
        "dir": "b",  # backwards from end
        "limit": str(BACKLOG_CHECK),
    }
    if since_token:
        params["from"] = since_token

    query = urllib.parse.urlencode(params)
    path = f"/rooms/{ROOM_ID}/messages?{query}"
    return matrix_api("GET", path)


def find_unanswered_commands(messages_resp):
    """
    Scan recent messages for '!telemetry' commands that don't have
    a subsequent telemetry response. Returns True if we should respond.
    
    Strategy: walk backwards through messages. If the most recent message
    is a '!telemetry' command, we need to respond. If the most recent
    is a telemetry response, we're done (already answered).
    """
    if not messages_resp:
        return False

    chunk = messages_resp.get("chunk", [])
    if not chunk:
        return False

    # Messages come in reverse chronological order (dir=b)
    # Find the most recent non-command, non-telemetry context
    for event in chunk:
        if event.get("type") != "m.room.message":
            continue
        body = event.get("content", {}).get("body", "").strip()

        # First telemetry response we see means it's already been answered
        if "CVM Telemetry" in body:
            return False

        # First !telemetry command we see (and no response above it) means respond
        if body == "!telemetry":
            return True

        # Any other message — stop looking, there's no pending command
        return False

    return False


def main():
    if not HS or not TOKEN:
        print("ERROR: MATRIX_HOMESERVER and MATRIX_ACCESS_TOKEN must be set", file=sys.stderr)
        sys.exit(1)

    print(f"Smithers telemetry listener starting (room: {ROOM_ID})")
    print(f"Polling /messages every {POLL_INTERVAL}s — quiescent until commanded")

    poll_count = 0
    responses_sent = 0

    while True:
        try:
            messages = get_recent_messages()
            if messages:
                if find_unanswered_commands(messages):
                    ts = time.strftime("%H:%M:%S")
                    print(f"[{ts}] Pending !telemetry found — collecting stats...")
                    body = get_stats()
                    event_id = post_message(body)
                    responses_sent += 1
                    print(f"[{ts}] Responded: {event_id or 'FAILED'} (total: {responses_sent})")
        except Exception as e:
            print(f"[{time.strftime('%H:%M:%S')}] Error: {e}", file=sys.stderr)

        poll_count += 1
        if poll_count % 120 == 0:
            ts = time.strftime("%H:%M:%S")
            print(f"[{ts}] Heartbeat — {poll_count} polls, {responses_sent} responses sent")

        time.sleep(POLL_INTERVAL)


if __name__ == "__main__":
    main()
