# Smithers Dashboard — On-Demand Telemetry Plan

## Problem
Current telemetry agent (`telemetry.py`) POSTs system stats to Matrix on a loop every N seconds, whether anyone is reading or not. Dashboard user opens the page a few times per week — 99% of those posts are wasted bandwidth and storage.

## Architecture: Request/Response via Matrix

```
Browser (dashboard.html)
  │
  │ 1. Connect to Matrix room (existing)
  │ 2. Send "!telemetry" command message to room
  │
  ▼
Matrix Homeserver (room: #smithers-dashboard)
  │
  │ 3. Delivers "!telemetry" to TEE listener
  │
  ▼
TEE (telemetry-listener.py)
  │
  │ 4. Collects CPU, mem, disk, load, network, uptime
  │ 5. POSTs telemetry response to same room
  │
  ▼
Matrix Homeserver
  │
  │ 6. Delivers telemetry to browser via sync
  │
  ▼
Browser — renders single in-place telemetry card
```

## Components

### 1. Dashboard (`js/dashboard-app.js`) — changes
- After connecting and loading backlog, send `!telemetry` to the room
- Add a "Refresh" button that sends `!telemetry` again
- On receiving a telemetry response, update the single in-place card (already implemented)
- Ignore stale backlog telemetry — only render the freshest
- Optional: auto-refresh every 60s while the tab is active (with Page Visibility API to pause when hidden)

### 2. Telemetry Listener (`telemetry-listener.py`) — new, replaces telemetry.py
- Long-running process that listens to the Matrix room via `/sync` long-polling
- On receiving `!telemetry` command from an authorized user, collects stats and POSTs response
- Quiescent otherwise — near-zero resource usage while idle
- Uses Matrix `/sync` with a long timeout (30s) so it's efficient

### 3. Telemetry Sender Removal
- Delete `telemetry.py` (the old loop-based poster)
- It served its purpose for testing

## Testing Plan (local first, deploy last)

All tests via Playwright against local HTTP server + live Matrix homeserver.

### Test 1: Dashboard sends command
- Load dashboard with valid config
- Verify it sends `!telemetry` message to the room after connecting
- Verify "Refresh" button also sends `!telemetry`

### Test 2: Listener receives and responds
- Start telemetry-listener.py in background
- Send `!telemetry` to room via REST API
- Verify listener posts a response containing "CVM Telemetry"

### Test 3: E2E round-trip
- Start listener in background
- Open dashboard via Playwright
- Dashboard auto-sends `!telemetry`
- Listener picks it up, posts telemetry
- Dashboard receives and renders the telemetry card
- Click "Refresh" → second round-trip works
- Verify only one telemetry card exists in DOM (in-place update)

### Test 4: Quiescence
- With listener running but no dashboard connected
- Verify no messages posted to room over 30s window
- Verify listener CPU usage is negligible

### Test 5: Deploy
- Push changes to GitHub Pages
- Verify dashboard loads and auto-requests telemetry
- Verify listener responds

## File Changes

| File | Action |
|------|--------|
| `js/dashboard-app.js` | Add: send `!telemetry` after connect, Refresh button, auto-refresh |
| `dashboard.html` | Add: Refresh button in UI |
| `telemetry-listener.py` | Create: on-demand listener replacing loop poster |
| `telemetry.py` | Delete (or keep for reference, stop running) |
| `test_dashboard.py` | Update: add tests for command sending, round-trip, quiescence |

## Security Considerations
- `!telemetry` is a read-only command — no risk even if spoofed
- Dashboard already has the bot token, so it's authorized
- Listener validates the sender if needed (optional, low priority since telemetry is harmless)
- Telemetry data is the same non-sensitive system stats as before
