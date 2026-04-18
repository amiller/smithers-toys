#!/usr/bin/env python3
"""
Smithers telemetry agent — posts CVM system stats to the Matrix dashboard room.
Run directly or via cron.
"""

import json
import os
import time
import subprocess
import sys
import urllib.request

HS = os.environ.get("MATRIX_HOMESERVER", "").strip()
TOKEN = os.environ.get("MATRIX_ACCESS_TOKEN", "").strip()
ROOM_ID = os.environ.get("SMITHERS_DASHBOARD_ROOM", "!KBLhManwDt1zUJ3DRw:a8629a1195ecb53afe1700cd3bafda1d18d9635d-6167.dstack-pha-prod7.phala.network")

def get_stats():
    """Collect system stats from /proc and standard tools."""
    stats = {}

    # CPU usage from /proc/stat (delta between two reads)
    with open("/proc/stat") as f:
        line1 = f.readline().split()
    time.sleep(0.5)
    with open("/proc/stat") as f:
        line2 = f.readline().split()

    idle1 = int(line1[4])
    idle2 = int(line2[4])
    total1 = sum(int(x) for x in line1[1:])
    total2 = sum(int(x) for x in line2[1:])
    diff_idle = idle2 - idle1
    diff_total = total2 - total1
    cpu_pct = (1.0 - diff_idle / max(diff_total, 1)) * 100

    # Memory from /proc/meminfo
    mem = {}
    with open("/proc/meminfo") as f:
        for line in f:
            parts = line.split()
            mem[parts[0].rstrip(":")] = int(parts[1])  # in kB

    mem_total_mb = mem["MemTotal"] / 1024
    mem_available_mb = mem["MemAvailable"] / 1024
    mem_used_pct = ((mem["MemTotal"] - mem["MemAvailable"]) / mem["MemTotal"]) * 100

    # Load average
    with open("/proc/loadavg") as f:
        load = f.read().split()
    load_1m = float(load[0])
    load_5m = float(load[1])
    load_15m = float(load[2])

    # Uptime
    with open("/proc/uptime") as f:
        uptime_sec = float(f.read().split()[0])
    uptime_hours = uptime_sec / 3600

    # Disk usage on /
    df = subprocess.run(["df", "-h", "/"], capture_output=True, text=True).stdout.split("\n")
    if len(df) >= 2:
        parts = df[1].split()
        disk_used = parts[2]
        disk_total = parts[1]
        disk_pct = parts[4].rstrip("%")
    else:
        disk_used = disk_total = disk_pct = "?"

    # Network bytes from /proc/net/dev (eth0 or first non-lo interface)
    net_rx = net_tx = 0
    with open("/proc/net/dev") as f:
        for line in f:
            if ": " not in line:
                continue
            iface, data = line.split(":")
            iface = iface.strip()
            if iface == "lo":
                continue
            parts = data.split()
            net_rx += int(parts[0])
            net_tx += int(parts[8])
            break  # just first non-lo

    stats = {
        "cpu_pct": round(cpu_pct, 1),
        "mem_total_mb": round(mem_total_mb, 0),
        "mem_available_mb": round(mem_available_mb, 0),
        "mem_used_pct": round(mem_used_pct, 1),
        "load_1m": load_1m,
        "load_5m": load_5m,
        "load_15m": load_15m,
        "uptime_hours": round(uptime_hours, 1),
        "disk_used": disk_used,
        "disk_total": disk_total,
        "disk_pct": disk_pct,
        "net_rx_mb": round(net_rx / 1024 / 1024, 1),
        "net_tx_mb": round(net_tx / 1024 / 1024, 1),
        "timestamp": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
    }
    return stats


def post_message(body):
    """Post a message to the Matrix room via REST API."""
    txn_id = f"telem-{int(time.time()*1000)}"
    url = f"{HS}/_matrix/client/v3/rooms/{ROOM_ID}/send/m.room.message/{txn_id}"
    payload = json.dumps({
        "msgtype": "m.text",
        "body": body,
    }).encode()

    req = urllib.request.Request(url, data=payload, method="PUT")
    req.add_header("Authorization", f"Bearer {TOKEN}")
    req.add_header("Content-Type", "application/json")

    try:
        with urllib.request.urlopen(req, timeout=10) as resp:
            result = json.loads(resp.read())
            return result.get("event_id")
    except Exception as e:
        print(f"Post failed: {e}", file=sys.stderr)
        return None


def main():
    interval = int(sys.argv[1]) if len(sys.argv) > 1 else 10
    count = int(sys.argv[2]) if len(sys.argv) > 2 else 0  # 0 = infinite

    if not HS or not TOKEN:
        print("ERROR: MATRIX_HOMESERVER and MATRIX_ACCESS_TOKEN must be set", file=sys.stderr)
        sys.exit(1)

    print(f"Smithers telemetry agent starting (interval={interval}s)")
    posted = 0

    while True:
        stats = get_stats()
        body = (
            f"[Smithers] CVM Telemetry | "
            f"CPU: {stats['cpu_pct']}% | "
            f"Mem: {stats['mem_available_mb']:.0f}/{stats['mem_total_mb']:.0f} MB ({stats['mem_used_pct']}%) | "
            f"Load: {stats['load_1m']} | "
            f"Uptime: {stats['uptime_hours']}h | "
            f"Disk: {stats['disk_used']}/{stats['disk_total']} ({stats['disk_pct']}%) | "
            f"Net RX: {stats['net_rx_mb']} MB TX: {stats['net_tx_mb']} MB"
        )

        event_id = post_message(body)
        posted += 1
        ts = time.strftime("%H:%M:%S")
        print(f"[{ts}] Posted #{posted}: {event_id or 'FAILED'}")

        if count and posted >= count:
            print(f"Reached count limit ({count}), stopping.")
            break

        time.sleep(interval)


if __name__ == "__main__":
    main()
