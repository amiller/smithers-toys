#!/usr/bin/env python3
"""
End-to-end tests for the Smithers on-demand telemetry system.

Tests:
1. Listener detects unanswered !telemetry commands
2. Listener responds with telemetry data
3. Dashboard sends !telemetry after connecting
4. Dashboard renders telemetry response in-place (single card)
5. Quiescence — no messages posted without a command
"""

import json
import subprocess
import sys
import time
import threading
import urllib.request
import urllib.parse
import http.server
import os
import signal

from playwright.sync_api import sync_playwright

HS = "https://a8629a1195ecb53afe1700cd3bafda1d18d9635d-6167.dstack-pha-prod7.phala.network"
TOKEN = "JboZorUAWsmJFiEl1FT2a0Wc7KKpyUli"
ROOM_ID = "!KBLhManwDt1zUJ3DRw:a8629a1195ecb53afe1700cd3bafda1d18d9635d-6167.dstack-pha-prod7.phala.network"

DASHBOARD_DIR = os.path.dirname(os.path.abspath(__file__))
HTTP_PORT = 9876


def matrix_api(method, path, data=None, timeout=10):
    url = f"{HS}/_matrix/client/v3{path}"
    body = json.dumps(data).encode() if data else None
    req = urllib.request.Request(url, data=body, method=method)
    req.add_header("Authorization", f"Bearer {TOKEN}")
    req.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return json.loads(resp.read())
    except urllib.error.HTTPError as e:
        return json.loads(e.read())
    except Exception as e:
        return {"error": str(e)}


def send_message(body_text):
    txn_id = f"test-{int(time.time()*1000)}"
    return matrix_api("PUT", f"/rooms/{ROOM_ID}/send/m.room.message/{txn_id}", {
        "msgtype": "m.text",
        "body": body_text,
    })


def get_recent_messages(limit=10):
    params = urllib.parse.urlencode({"dir": "b", "limit": str(limit)})
    return matrix_api("GET", f"/rooms/{ROOM_ID}/messages?{params}")


class QuietHandler(http.server.SimpleHTTPRequestHandler):
    def log_message(self, format, *args):
        pass  # suppress request logs


def start_http_server():
    os.chdir(DASHBOARD_DIR)
    server = http.server.HTTPServer(("127.0.0.1", HTTP_PORT), QuietHandler)
    server.daemon_threads = True
    t = threading.Thread(target=server.serve_forever, daemon=True)
    t.start()
    return server


def start_listener():
    """Start the telemetry listener in background, return process."""
    env = os.environ.copy()
    env["MATRIX_HOMESERVER"] = HS
    env["MATRIX_ACCESS_TOKEN"] = TOKEN
    env["SMITHERS_DASHBOARD_ROOM"] = ROOM_ID
    proc = subprocess.Popen(
        [sys.executable, os.path.join(DASHBOARD_DIR, "telemetry-listener.py")],
        env=env,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
    )
    return proc


def stop_listener(proc):
    if proc.poll() is None:
        proc.terminate()
        try:
            proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            proc.kill()


# ─── Test 1: Listener detects and responds to !telemetry ───

def test_listener_responds():
    print("\n=== Test 1: Listener responds to !telemetry ===")
    
    # Start listener
    listener = start_listener()
    time.sleep(2)  # let it initialize
    
    try:
        # Send !telemetry command
        result = send_message("!telemetry")
        print(f"  Sent !telemetry: {result.get('event_id', 'FAILED')}")
        assert result.get("event_id"), f"Failed to send command: {result}"
        
        # Wait for listener to respond (poll + collect + post)
        found_response = False
        for _ in range(15):  # up to 15 seconds
            time.sleep(1)
            messages = get_recent_messages(5)
            chunk = messages.get("chunk", [])
            for event in chunk:
                body = event.get("content", {}).get("body", "")
                if "CVM Telemetry" in body:
                    found_response = True
                    print(f"  Got response: {body[:80]}...")
                    assert "CPU:" in body
                    assert "Mem:" in body
                    assert "Disk:" in body
                    break
            if found_response:
                break
        
        assert found_response, "Listener did not respond within 15s"
        print("  PASSED")
    finally:
        stop_listener(listener)


# ─── Test 2: Quiescence — no unsolicited messages ───

def test_quiescence():
    print("\n=== Test 2: Quiescence — no unsolicited messages ===")
    
    # Get current message count
    messages_before = get_recent_messages(1)
    top_event_before = None
    chunk = messages_before.get("chunk", [])
    if chunk:
        top_event_before = chunk[0].get("event_id")
    
    # Start listener and wait 12 seconds (2+ poll cycles)
    listener = start_listener()
    time.sleep(2)  # init
    time.sleep(12)  # quiescent period
    stop_listener(listener)
    
    # Check no new messages
    messages_after = get_recent_messages(1)
    chunk = messages_after.get("chunk", [])
    top_event_after = chunk[0].get("event_id") if chunk else None
    
    assert top_event_after == top_event_before, \
        f"Listener posted unsolicited messages! Before: {top_event_before}, After: {top_event_after}"
    print("  No unsolicited messages detected")
    print("  PASSED")


# ─── Test 3: Dashboard sends !telemetry on connect ───

def test_dashboard_sends_command():
    print("\n=== Test 3: Dashboard sends !telemetry on connect ===")
    
    with sync_playwright() as p:
            browser = p.chromium.launch(headless=True)
            page = browser.new_page()
            
            # Collect console messages
            console_msgs = []
            page.on("console", lambda msg: console_msgs.append(msg.text))
            
            # Load dashboard with auto-connect via hash params
            url = (
                f"http://127.0.0.1:{HTTP_PORT}/dashboard.html"
                f"#hs={urllib.parse.quote(HS)}"
                f"&room={urllib.parse.quote(ROOM_ID)}"
                f"&token={urllib.parse.quote(TOKEN)}"
            )
            page.goto(url, wait_until="networkidle", timeout=60000)
            
            # Wait for connect + E2EE crypto init + command send
            # Use Playwright's built-in wait for the specific console message
            try:
                with page.expect_console_message(
                    lambda msg: "Sent !telemetry command" in msg.text,
                    timeout=90000
                ) as msg_info:
                    pass  # just waiting for the message
                found = True
            except Exception:
                found = False
            
            if not found:
                # Check what state we're in
                status = page.locator("#statusText").text_content()
                lock = page.locator("#lockIcon").text_content()
                print(f"  Status: {status}, Lock: {lock}")
                interesting = [m for m in console_msgs if "FetchHttpApi" not in m and "Crypto callbacks" not in m]
                print(f"  Interesting console ({len(interesting)}/{len(console_msgs)} total):")
                for msg in interesting[-30:]:
                    print(f"    {msg[:150]}")
            
            assert found, f"Dashboard did not send !telemetry within 60s"
            print(f"  Dashboard sent !telemetry command")
            
            # Check status is connected
            status_text = page.locator("#statusText").text_content()
            assert status_text == "Connected", f"Status: {status_text}"
            print(f"  Status: {status_text}")
            
            browser.close()
    
    print("  PASSED")


# ─── Test 4: E2E round-trip with live listener ───

def test_e2e_roundtrip():
    print("\n=== Test 4: E2E round-trip (dashboard → listener → dashboard) ===")
    
    # Start listener
    listener = start_listener()
    time.sleep(2)
    
    try:
        with sync_playwright() as p:
            browser = p.chromium.launch(headless=True)
            page = browser.new_page()
            
            url = (
                f"http://127.0.0.1:{HTTP_PORT}/dashboard.html"
                f"#hs={urllib.parse.quote(HS)}"
                f"&room={urllib.parse.quote(ROOM_ID)}"
                f"&token={urllib.parse.quote(TOKEN)}"
            )
            page.goto(url, wait_until="networkidle", timeout=60000)
            
            # Wait for full round-trip: connect → send !telemetry → listener responds → render
            time.sleep(25)
            
            # Check that telemetry card exists and is single
            cards = page.locator("#telemetryLive")
            count = cards.count()
            assert count == 1, f"Expected 1 telemetry card, found {count}"
            print(f"  Single telemetry card rendered (in-place update works)")
            
            # Check it has content
            card_text = cards.first.text_content()
            assert "CVM Telemetry" in card_text, f"Card content: {card_text[:100]}"
            print(f"  Card contains telemetry data")
            
            browser.close()
    finally:
        stop_listener(listener)
    
    print("  PASSED")


# ─── Test 5: In-place update — no DOM growth ───

def test_no_dom_growth():
    print("\n=== Test 5: No DOM growth on repeated telemetry ===")
    
    # Start listener
    listener = start_listener()
    time.sleep(2)
    
    try:
        with sync_playwright() as p:
            browser = p.chromium.launch(headless=True)
            page = browser.new_page()
            
            url = (
                f"http://127.0.0.1:{HTTP_PORT}/dashboard.html"
                f"#hs={urllib.parse.quote(HS)}"
                f"&room={urllib.parse.quote(ROOM_ID)}"
                f"&token={urllib.parse.quote(TOKEN)}"
            )
            page.goto(url, wait_until="networkidle", timeout=60000)
            time.sleep(25)  # first round-trip
            
            # Count children of #feed before
            children_before = page.evaluate("document.getElementById('feed').children.length")
            
            # Force another telemetry request
            page.evaluate("requestTelemetry()")
            time.sleep(10)  # wait for response
            
            # Count children after
            children_after = page.evaluate("document.getElementById('feed').children.length")
            
            # Should be same or at most +1 (if a non-telemetry message arrived)
            assert children_after <= children_before + 1, \
                f"DOM grew unexpectedly: {children_before} → {children_after}"
            print(f"  Feed children: {children_before} → {children_after} (no growth)")
            
            # Verify still only 1 telemetry card
            telem_count = page.locator("#telemetryLive").count()
            assert telem_count == 1, f"Multiple telemetry cards: {telem_count}"
            print(f"  Still just 1 telemetry card")
            
            browser.close()
    finally:
        stop_listener(listener)
    
    print("  PASSED")


# ─── Main ───

if __name__ == "__main__":
    # Start a single HTTP server for all browser tests
    os.chdir(DASHBOARD_DIR)
    server = http.server.HTTPServer(("127.0.0.1", HTTP_PORT), QuietHandler)
    server.daemon_threads = True
    server_thread = threading.Thread(target=server.serve_forever, daemon=True)
    server_thread.start()
    
    tests = [
        ("Quiescence", test_quiescence),
        ("Listener responds", test_listener_responds),
        ("Dashboard sends command", test_dashboard_sends_command),
        ("E2E round-trip", test_e2e_roundtrip),
        ("No DOM growth", test_no_dom_growth),
    ]
    
    passed = 0
    failed = 0
    
    print(f"Running {len(tests)} tests...")
    
    for name, fn in tests:
        try:
            fn()
            passed += 1
        except Exception as e:
            print(f"  FAILED: {e}")
            failed += 1
    
    server.shutdown()
    
    print(f"\n{'='*50}")
    print(f"Results: {passed} passed, {failed} failed out of {len(tests)}")
    
    sys.exit(0 if failed == 0 else 1)
