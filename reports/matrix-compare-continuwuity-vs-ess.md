# Continuwuity vs. Element Server Suite (ESS) Community Edition

**A feature comparison between two self-hosted Matrix homeserver distributions.**

*Report date: 2026-04-22.* Reflects Continuwuity v0.5.5 (Feb 2026) and ESS Community 26.1.1 / 26.2.0 (Q1 2026). Some details are sourced from upstream projects (conduwuit, Synapse) where the downstream docs are thin; those are noted inline.

---

## 1. At-a-glance summary

| Area | Continuwuity | ESS Community |
|---|---|---|
| **Core engine** | Single Rust binary (fork of conduwuit / Conduit) | Synapse (Python + Rust modules) |
| **Deployment shape** | Standalone binary, Docker, NixOS, Debian/Fedora/Arch, FreeBSD, k8s (generic) | Helm chart on Kubernetes (K3s, microk8s, etc.) |
| **Architecture** | Single process, no workers | Multi-process microservices: Synapse (main + optional workers), MAS, Element Web, Element Call SFU + lk-jwt-service, HAProxy, PostgreSQL, Hookshot (optional) |
| **Database** | RocksDB only | PostgreSQL (bundled or external); no SQLite in prod |
| **Target scale** | Small to mid (tens–low hundreds of users) | ~1–100 users (explicit product scope) |
| **Matrix 2.0 (OIDC-native, Simplified Sliding Sync, Element Call, Element X-ready)** | Partial — Simplified Sliding Sync yes; native OIDC/MAS-style flows no (still legacy auth + LDAP/recaptcha/registration tokens) | Full — MAS is a first-class component |
| **Element Call / MatrixRTC** | Integration points for external LiveKit + `matrix_rtc` foci; you bring the SFU | Bundled — LiveKit SFU + lk-jwt-service ship in the chart |
| **Sliding Sync (MSC4186)** | Yes, native (legacy MSC3575 removed) | Yes, native in Synapse ≥ 1.114 |
| **E2EE (cross-signing, key backup, SSSS)** | Supported | Supported (Synapse) |
| **Dehydrated devices (MSC3814)** | Yes (added 2026) | Experimental in Synapse |
| **Knock + restricted rooms** | Yes | Yes |
| **Threads, Spaces** | Yes | Yes |
| **Bridging / appservice** | Appservice protocol supported; no bundled bridges | Appservice supported; Hookshot bundled (opt-in) since 26.1.1 |
| **Admin surface** | Admin room + CLI-style commands; growing HTTP admin API | Synapse Admin API + Element Admin web console + MAS admin CLI |
| **SSO** | LDAP, registration tokens, reCAPTCHA, SMTP password reset | MAS: OIDC upstreams (Keycloak, Dex, etc.), password, registration |
| **TLS** | Native TLS or reverse proxy | HAProxy + ingress; usually terminated at the cluster ingress |
| **License** | Apache-2.0 (inherited from Conduit lineage) | AGPL-3.0 |
| **Support model** | Community only (Matrix room, forge) | Community only; paid SLA via ESS Pro |

---

## 2. Matrix spec compliance

### Continuwuity
A focus of the project is "improving Matrix protocol compliance." v0.5.x release notes explicitly cite:

- **MSC3202** / **MSC4190** — appservice device masquerading
- **MSC3814** — Dehydrated devices (receive E2EE messages while logged out)
- **MSC4133** — extended profile fields
- **MSC4143** — MatrixRTC transport discovery (the `rtc_foci` well-known mechanism used by Element Call)
- **MSC4155** — invite filtering
- **MSC4186** — Simplified Sliding Sync (legacy **MSC3575** was removed in v0.5)
- **MSC4284** — policy servers (with signature support and better error handling)
- **MSC4323** — user suspension
- **MSC4373** — EDU opt-out (decline incoming typing/presence)
- **MSC4406** — `M_SENDER_IGNORED` error
- **MSC4439** — PGP key URIs
- Room version 12 state-resolution fixes

Client-Server API coverage is described by maintainers as "not too far behind Synapse" and improving. Sliding Sync extensions (read receipts / **MSC3960**, typing, heroes, per-room account data) are implemented. There is no separate sliding-sync proxy required.

Federation is on by default, with regex-based allow/deny for remote servers, configurable key-server trust, CIDR denylist for outbound requests (RFC1918 etc. blocked by default), and deprioritization of slow servers during joins. Federated presence is **off by default** since early 2026 releases (local presence still on).

### ESS Community (Synapse)
Synapse is the reference homeserver and is generally the first implementation of any given MSC; ESS Community tracks upstream Synapse. Notable coverage:

- **MSC3575 / MSC4186** — Sliding Sync: native in Synapse ≥ 1.114, no proxy required
- **MSC2946** — Spaces Summary
- **MSC3773** — server-assisted thread notifications
- **MSC3787** — `knock_restricted` join rule
- **MSC3967** — cross-signing setup without UIA
- Knocking (room v7+), restricted rooms (room v8+), threads (v1.4), Spaces (v1.2)
- Dehydrated devices (MSC3814) — experimental
- OIDC-native auth via **MSC3861** through MAS

Because Synapse is the canonical implementation, compliance is generally the most complete of any homeserver.

---

## 3. Performance characteristics

### Continuwuity
- **Architecture:** single Rust process; no workers, no Redis replication, no separate media repo. A "complete rewrite of sync code" landed in 2026.
- **Database:** RocksDB only. Binaries are built with hardware-accelerated CRC32. Online backups via RocksDB's backup API. Database is not compatible with Conduit or Grapevine (one-way migration).
- **Tuning knobs:** affinity-aware DB worker pools, per-component LRU cache sizes (`cache_capacity_modifier`), DNS TTL cache (incl. NXDOMAIN), stream-width/amplification factors, compression (ZSTD/BZ2/LZ4).
- **Footprint:** community reports on conduwuit (the predecessor) cite ~500 MB of DB and "barely noticeable" RAM/CPU for personal/small servers. Advertised as designed for "modest hardware."
- **Scaling model:** vertical only. There is no horizontal scale-out story; the project's sweet spot is a single box.

### ESS Community (Synapse)
- **Architecture:** Synapse main process plus optional specialized **workers** (sync, federation-sender, federation-receiver, media, pushers, etc.). Coordination is Redis pub/sub + HTTP replication + shared PostgreSQL.
- **Database:** PostgreSQL is required for any non-demo deployment. The chart can run a bundled PostgreSQL or point at an external managed one.
- **Footprint:** Synapse itself is heavier — community rule-of-thumb is 4–8 cores / 8 GB RAM / lots of disk for anything public. The ESS quick-start calls for **at least 2 CPU / 2 GB RAM** for a single-node K3s install of the whole stack, which is realistic for evaluation/home use.
- **Scaling model:** horizontal via workers. ESS Community does **not** bundle the autoscaling / multi-tenant / Synapse Pro optimizations that ship in ESS Pro; it is intentionally capped at ~100 users.

**Practical take:** for a solo admin with a handful of users, Continuwuity will idle lower and start faster. For a federated community that might outgrow a single box, Synapse's worker model is the known-good path, and ESS Community wires it up for you.

---

## 4. Deployment model

### Continuwuity
- Official packaging: Docker, Debian, Fedora, NixOS, Arch, FreeBSD, generic Linux binaries, a Kubernetes "generic" recipe.
- Config is a single TOML file with a `[global]` section plus sub-sections (`[global.tls]`, `[global.ldap]`, `[global.smtp]`, `[global.matrix_rtc]`, `[global.well_known]`, etc.).
- TLS: native (`[global.tls]`) or reverse proxy in front.
- A "first-run experience" (added 2026) replaces the older "first-user dance" — you can declare admins in config and disable admin-room-based admin discovery entirely.
- Media is stored on the filesystem in a single directory (with symlink compatibility for Conduit migration).

### ESS Community
- Helm chart (`element-hq/ess-helm`) targeting any Kubernetes distribution. The project documents K3s and microk8s for single-node deployments.
- Config is Helm `values.yaml`, composed from per-component snippets (Synapse, MAS, Element Web, Element Call, Matrix RTC, Hookshot, PostgreSQL).
- Components bundled: **Synapse, Matrix Authentication Service (MAS), Element Web, Element Admin console, Element Call with its MatrixRTC LiveKit backend + lk-jwt-service, HAProxy, optional PostgreSQL, optional Hookshot.**
- `.well-known/matrix/{client,server}` delegation is emitted by the chart.
- TLS is typically terminated at the cluster ingress; the chart also supports TURN-TLS and UDP TURN for Matrix RTC behind restrictive networks.
- Supports `extraInitContainers` on every workload, Prometheus Operator / Victoria Metrics `ServiceMonitor` generation, and external Redis for Hookshot.

**Practical take:** If you already run k8s, ESS gives you a batteries-included Matrix stack with one chart. If you don't, Continuwuity's single binary is dramatically simpler.

---

## 5. Administration features

### Continuwuity
- **Admin room** with slash-style commands (`!admin …`) — the main operator UI.
- Growing HTTP admin API (listed as a work-in-progress focus area in the README).
- Explicit support for:
  - Forcing specific users to admin regardless of admin-room membership, or disabling admin-room discovery entirely.
  - Locking user accounts and force-logging-out all sessions.
  - User suspension (MSC4323).
  - Forbidden username/alias regex patterns; auto-deactivation of users who try to join banned rooms.
  - Registration tokens (static in config, from file, or DB-managed with expirations).
  - Emergency password for the server bot account.
  - URL-preview purge command and configurable user agents.
  - Policy server integration (MSC4284) for moderation.
- No bundled web admin console; third-party admin UIs that speak the Synapse admin API will **not** work out of the box because Continuwuity's API surface is different.

### ESS Community
- **Synapse Admin API** (rooms, users, media, federation, registration tokens, quarantine, device management, pushers, server notices, etc.).
- **Element Admin** web console bundled.
- **MAS admin CLI / API** for account and session management, consent, and upstream-IdP linkage.
- Third-party tools (synadm, Ketesa / Synapse-Admin fork) work because the API is stable and documented.
- Hookshot integration has a pre-wired default permissions policy so local users only manage their own integrations.

**Practical take:** ESS has a much richer admin ecosystem today; Continuwuity's admin-room workflow is quick but idiosyncratic.

---

## 6. End-to-end encryption

Both servers implement the server-side pieces of E2EE — the crypto itself lives in the client — but the spec surface they expose differs slightly.

| Feature | Continuwuity | ESS Community |
|---|---|---|
| Device keys / one-time keys / fallback keys | Yes | Yes |
| Cross-signing | Yes | Yes |
| Server-side key backup (SSSS-backed) | Yes | Yes |
| Dehydrated devices (MSC3814) | **Yes (stable in 2026)** | Experimental |
| Key sharing to verified devices | Yes | Yes |
| Concurrent E2EE key lookups on federation | Optimized in 0.5.x | Yes |
| Knock + restricted rooms (needed for gated E2EE rooms) | Yes | Yes |
| `m.room.encryption` gate (disable E2EE rooms) | `allow_encryption` toggle | Configurable per-server |

---

## 7. Bridging and appservices

### Continuwuity
- Appservice protocol supported — explicitly called out as a focus area in the README and has a dedicated section in the docs on connecting appservices.
- MSC3202 / MSC4190 (device masquerading) implemented, which matters for modern bridges that want to represent remote device lists.
- **No bridges are bundled.** You run bridges (mautrix-*, matrix-hookshot, heisenbridge, etc.) as separate services.

### ESS Community
- Appservice protocol supported via Synapse.
- **Hookshot** (GitHub / GitLab / JIRA / generic webhooks) is bundled as of **26.1.1** (disabled by default, enable with `hookshot.enabled: true`).
- The chart added generic "generate appservice registration file with `matrix-tools`" support in 26.1.1, so adding any third-party bridge is straightforward.
- Other bridges (mautrix-*, etc.) are not bundled; you add them as additional Helm releases and register via the matrix-tools mechanism.

---

## 8. VoIP and video

### 1:1 WebRTC calls
Both servers relay signalling and issue TURN credentials. Both expose `turn_uris` / shared-secret TURN.

### Group calls / Element Call / MatrixRTC
| Piece | Continuwuity | ESS Community |
|---|---|---|
| `org.matrix.msc4143.rtc_foci` advertisement in `.well-known` | Yes (`[global.matrix_rtc]` foci config) | Yes (chart writes it for you) |
| LiveKit SFU | External — you run it | **Bundled** (MatrixRTC backend) |
| `lk-jwt-service` (JWT issuer for LiveKit) | External — you run it | **Bundled** |
| TURN-TLS / UDP TURN support in chart/config | TURN via generic TURN config | **Yes**, explicit chart options |
| Element Call client | You deploy separately | **Bundled** (Element Web hosts the widget) |
| E2EE group calls | Yes (client-side, per MSC4195) | Yes |
| `turn_allow_guests` for unauthenticated TURN credential issuance | Yes | Controlled via MAS/Synapse config |

For a Continuwuity operator who wants Element Call, the typical recipe is: run LiveKit + `lk-jwt-service` + Element Call client in Docker/Compose alongside Continuwuity, and point Continuwuity's `matrix_rtc.foci` at the `lk-jwt-service`. ESS Community just sets all that up.

---

## 9. Authentication

### Continuwuity
- Legacy Matrix `m.login.password`.
- **Registration tokens** — static (config), from file, or DB-managed with expirations.
- **reCAPTCHA** for open registration.
- **LDAP** (full `[global.ldap]` section: bind DN, search filter, attribute mapping, admin-role mapping).
- **SMTP** — password-reset and email verification.
- **T&C acceptance** gating.
- **Guest accounts** with optional auto-join rooms.
- `suspend_on_register` to screen new sign-ups.
- **No native SSO/OIDC/CAS/SAML** integration at the time of writing. OIDC-native Matrix 2.0 flows (MSC3861) are not implemented; users authenticate to the server directly.

### ESS Community
- **Matrix Authentication Service (MAS)** is the default auth front-end. Clients speak OAuth2 / OIDC to MAS; MAS holds the Matrix user DB.
- MAS supports **upstream OIDC providers** (Keycloak, Dex, Authentik, Google, etc.) for SSO.
- Password auth, registration, email verification, consent screens, token revocation.
- **No native CAS** (CAS is a legacy Synapse feature being deprecated as MAS takes over).
- reCAPTCHA via MAS.
- Registration tokens via MAS.

**Practical take:** if you need enterprise SSO, ESS is the clear choice. If you need "just let people sign up with a token and an optional LDAP bind," Continuwuity is fine and easier.

---

## 10. Sliding Sync / lazy loading / threading / ephemerals

| Feature | Continuwuity | ESS Community |
|---|---|---|
| **Simplified Sliding Sync (MSC4186)** — powers Element X instant launch | Yes, native. Legacy MSC3575 removed in 0.5. | Yes, native in Synapse ≥ 1.114. Proxy no longer needed. |
| Sliding-sync typing indicators | Fixed in 0.5.x | Yes |
| Sliding-sync read receipts (MSC3960) | Yes | Yes |
| Sliding-sync heroes, per-room account data | Yes | Yes |
| Lazy-loading room members | Yes | Yes |
| Threads (MSC3440 / room v11) | Yes | Yes |
| Thread notifications with server assist (MSC3773) | Yes | Yes |
| Presence opt-out (MSC4373) | Yes (native) | Partial |
| MSC3886 (simple client rendezvous for login transfer) | Not advertised | Yes (via MAS) |

Both are production-viable targets for **Element X** mobile clients in 2026.

---

## 11. Notable / unique features

### Continuwuity-specific
- **Single binary, RocksDB, no workers** — easiest "one box, one config file" Matrix server in the ecosystem.
- **Dehydrated devices stable** before Synapse fully ships it.
- **MSC4373 EDU opt-out** — operators can globally decline remote typing/presence to save resources.
- **Policy server (MSC4284) with signatures** for moderation-as-a-service.
- **Federated presence off by default** (privacy-oriented default).
- **Forbidden-alias / forbidden-username regex, auto-deactivate-on-banned-room-join** — aggressive anti-abuse primitives.
- **First-run experience** — no more initial-user race/claim ceremony.
- **`emergency_password`** for the bot account.
- **OpenTelemetry / Sentry / flamegraph tracing** built in.
- **CIDR denylist for outbound federation** (RFC1918 by default) — blocks SSRF-style abuse automatically.
- Fork lineage: Conduit → conduwuit (abandoned May 2025) → **Continuwuity** (official continuation). Note an unrelated parallel fork exists: **Tuwunel** (`matrix-construct/tuwunel`) — which also self-describes as "official successor to conduwuit," so pick your community carefully.
- License: Apache-2.0 (permissive).

### ESS Community-specific
- **All of Matrix 2.0 in one chart** — OIDC-native login, Simplified Sliding Sync, Element Call, Element X, packaged consistently.
- **Element Admin web console** out of the box.
- **Bundled Element Call stack** (LiveKit SFU + lk-jwt-service + Element Call web client + MatrixRTC Authorization Service).
- **Hookshot** integration bundled (opt-in).
- **.well-known delegation** emitted automatically.
- **Prometheus Operator / VictoriaMetrics ServiceMonitor** resources generated.
- **`extraInitContainers` on every workload** for custom bootstrap.
- **Clear upgrade path** to ESS Pro (multi-tenancy, autoscaling, LDAP/SCIM, S3 media, malware scanning, audit, HA, vendor SLA) without migrating data.
- License: AGPL-3.0 (copyleft — relevant if you plan to modify and offer as a network service).
- Scope limit: **1–100 users, non-commercial**. There are no SLAs, no SBOM, and the distribution is not Cyber Resilience Act compliant — Element reserves those for Pro.

---

## 12. Recommendations

### Small homeserver (1 admin, friends and family, maybe a handful of rooms)
**Pick Continuwuity.**
- Single binary, trivial config file, RocksDB means you don't run Postgres.
- Memory and CPU stay negligible; it will live happily on a Raspberry Pi-class box or a small VPS.
- You lose SSO and bundled Element Call, but 1:1 calls and normal E2EE work fine.
- Caveat: if you want group video calls with Element Call, you'll have to assemble LiveKit + lk-jwt-service yourself.

### Mid-size community (dozens to ~100 users, maybe one bridge, group video)
**Slight edge to ESS Community if you're comfortable with Kubernetes.** You get Element Call, MAS/OIDC, Element Admin, Hookshot, and the upgrade path to Pro — without integration work. Pick Continuwuity instead if:
- You explicitly want to avoid k8s and/or Postgres.
- You don't need SSO or Element Call.
- Your admins prefer a config file and an admin room to a Helm chart and a web console.

### Enterprise / professional use
**Neither is the right answer — use ESS Pro.** ESS Community is *explicitly* scoped to non-commercial / non-professional up to 100 users, with no SLA, no SBOM, no CRA compliance, and no vendor responsibility. Continuwuity is community-maintained with no commercial-support contract. If you need horizontal scaling beyond workers, multi-tenancy, LDAP/SCIM, S3 media, malware scanning, audit logs, or vendor accountability, ESS Pro (or a supported Synapse from another vendor) is what you actually want. Use Continuwuity or ESS Community for staging and evaluation in that scenario.

### Privacy-/sovereignty-focused operator
**Continuwuity** has the more conservative defaults (federated presence off, EDU opt-out, CIDR denylist, aggressive moderation primitives, dehydrated devices shipped earlier). Its license (Apache-2.0) is also less restrictive if you need to modify and redistribute. Pair it with your own LiveKit if you want group calls.

### Organization that already standardizes on Kubernetes
**ESS Community.** The Helm chart will feel natural, `ServiceMonitor` resources drop straight into your existing observability stack, Hookshot slots in for GitHub/GitLab notifications, and the upgrade path to ESS Pro is painless if scope grows.

---

## Sources

### Continuwuity
- Project site: <https://continuwuity.org/>
- Introduction / deployment docs: <https://continuwuity.org/introduction.html>, <https://continuwuity.org/deploying/generic>
- Config reference: <https://continuwuity.org/reference/config>
- Forgejo repo (canonical): <https://forgejo.ellis.link/continuwuation/continuwuity>
- GitHub mirror: <https://github.com/continuwuity/continuwuity>
- Codeberg mirror: <https://codeberg.org/continuwuity/continuwuity>
- Releases: <https://forgejo.ellis.link/continuwuation/continuwuity/releases>
- Community write-up: <https://edu4rdshl.dev/posts/about-to-leave-matrix-oh-wait-there-s-conduwuit/>
- Parallel fork (for disambiguation): <https://github.com/matrix-construct/tuwunel>

### Element Server Suite Community
- Product page: <https://element.io/en/server-suite/community>
- Helm repo: <https://github.com/element-hq/ess-helm>
- 26.1.1 release notes: <https://github.com/element-hq/ess-helm/releases/tag/26.1.1>
- Advanced docs: <https://github.com/element-hq/ess-helm/blob/main/docs/advanced.md>
- ESS announcement: <https://element.io/blog/welcome-to-the-all-new-element-server-suite-family-of-helm-charts/>
- Element Call for self-hosted: <https://element.io/blog/end-to-end-encrypted-voice-and-video-for-self-hosted-community-users/>

### Upstream components referenced
- Synapse: <https://github.com/element-hq/synapse>
- Matrix Authentication Service (MAS): <https://github.com/element-hq/matrix-authentication-service>
- Element Call: <https://github.com/element-hq/element-call>
- lk-jwt-service: <https://github.com/element-hq/lk-jwt-service>
- Sliding Sync / Matrix 2.0: <https://matrix.org/blog/2024/10/29/matrix-2.0-is-here/>
- MSC3575 spec proposal: <https://github.com/matrix-org/matrix-spec-proposals/pull/3575>

### Caveats on sources
- Continuwuity MSC lists were aggregated from release notes across v0.5.0-rc.8 through v0.5.5 — the per-MSC coverage is accurate as of those notes, but client-server API "completeness" relative to Synapse is the maintainers' own description ("not too far behind") rather than a measured conformance number.
- ESS Community feature coverage is inferred from the Helm chart's bundled components and the underlying Synapse/MAS versions it pins; where a feature is an upstream Synapse capability rather than an ESS-specific one, that is noted.
- Memory/CPU numbers for Continuwuity come from community self-reports on the predecessor conduwuit and are not vendor-published benchmarks.
