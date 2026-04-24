# Matrix Protocol - Crypto & Network Details Summary

## Cryptographic Architecture

### Core Encryption Primitives

**Olm (Double Ratchet) - 1:1 Messaging**
- **Key Exchange**: Triple Diffie-Hellman using Curve25519
  - Identity keys: `I_A`, `I_B` (long-term Ed25519 for signing, Curve25519 for DH)
  - Ephemeral keys: `E_A`, `E_B` (single-use Curve25519)
  - Shared secret: `S = ECDH(I_A, E_B) || ECDH(E_A, I_B) || ECDH(E_A, E_B)`

- **Key Derivation**: HKDF-SHA-256
  - Root key: info="OLM_ROOT"
  - Message keys: info="OLM_KEYS"
  - Output: 256-bit AES key + 256-bit HMAC key + 128-bit IV

- **Authenticated Encryption**:
  - AES-256-CBC with PKCS#7 padding
  - HMAC-SHA-256 (truncated to 64 bits)
  - Ed25519 signatures on pre-key messages

- **Ratchet Mechanism**:
  - Root key advances on DH between ratchet keys
  - Chain keys advance per message
  - Message keys derived from chain keys
  - Supports out-of-order delivery

**Megolm (Group Ratchet) - Group Messaging**
- **Ratchet Structure**: 4-part AES-based ratchet `R_{i,j}`
  - Each part: 256 bits
  - Reseeding intervals: 2^8, 2^16, 2^24 messages
  - Forward advancement in ≤1020 hash computations

- **Session Components**:
  - 32-bit message counter
  - Ed25519 signing keypair
  - Ratchet state (1024 bits random data)

- **Encryption**:
  - AES-256-CBC with PKCS#7 padding
  - HMAC-SHA-256 (truncated to 64 bits)
  - Ed25519 signatures on all messages
  - Keys derived via HKDF-SHA-256 (info="MEGOLM_KEYS")

**Key Management**
- Device-based: Each device has own keypairs
- Identity keys: Long-term Ed25519 for signing
- One-time keys: Curve25519 prekeys for initial sessions
- Device lists: Published and tracked by homeservers
- Cross-signing: Master → Self-signing → User-signing key hierarchy

## Security Properties

### Olm Security
- ✅ Forward secrecy: Current key compromise doesn't reveal past messages
- ⚠️ Limited post-compromise security: DH ratchets provide some protection
- ✅ Deniability: No digital signatures on message content
- ✅ Authentication: User IDs included in plaintext

### Megolm Security
- ⚠️ Partial forward secrecy: Recipients can decrypt historical messages
- ❌ No backward secrecy: Compromise reveals all future session messages
- ✅ Authentication: Ed25519 signatures prevent tampering
- ⚠️ Replay attacks: Possible without index tracking
- ❌ No transcript consistency: Different recipients may see different message sets

### Common Limitations
- **Key exchange**: Depends on secure channel (typically Olm)
- **Session rotation**: Required for security (Megolm sessions not indefinite)
- **Device compromise**: Exposes all device's conversation history
- **Server-side storage**: Encrypted content stored on servers

## Network Architecture

### Federation Protocol
- **Transport**: HTTPS with TLS (certificate validation mandatory)
- **Authentication**: Public key signatures in HTTP Authorization headers
- **Discovery**: `.well-known/matrix/server` → SRV `_matrix-fed._tcp` → direct:8448
- **Message Types**:
  - PDUs (Persistent): Events broadcast to all room servers
  - EDUs (Ephemeral): Direct server-to-server pushes
  - Queries: Request/response for snapshots

### Server Discovery Hierarchy
1. `https://<hostname>/.well-known/matrix/server` (24h cache)
2. SRV: `_matrix-fed._tcp.<hostname>`
3. Legacy SRV: `_matrix._tcp.<hostname>`
4. Direct: `<hostname>:8448` with valid TLS certificate

### Client-Server Communication
- **Transport**: HTTPS with TLS
- **API**: JSON over REST
- **Streaming**: Long-lived GET requests + WebSocket support
- **Authentication**: Access tokens with device IDs

## Metadata Exposure (Even with E2EE)

### Visible to Homeservers
**Message Metadata**:
- Timestamps (`origin_server_ts`, `received_ts`)
- Sender user IDs
- Room IDs
- Event types
- Message sizes and frequency
- Topological graph structure

**User Activity**:
- Online status and presence
- Device lists and identifiers
- Typing indicators
- Read receipts
- Profile changes
- Room membership (who talks to whom)
- Join/leave/invite events

**Network Metadata**:
- Client IP addresses
- Connection patterns and timing
- User-agent strings
- Bandwidth usage
- Server-to-server federation patterns

**Room State**:
- Room creation and configuration
- Power levels and permissions
- Room aliases and visibility
- Encryption state changes
- Room version upgrades

### Database Schema Evidence
```sql
-- Events table exposes significant metadata
events (
    origin_server_ts bigint,  -- Message timestamps
    received_ts bigint,       -- Server receipt time
    sender text,             -- Message sender
    room_id text,            -- Room identifier
    type text,               -- Event type (encrypted message, typing, etc.)
    topological_ordering bigint -- Message ordering
)

-- Users table
users (
    name text,               -- User ID
    creation_ts bigint,       -- Account creation time
    appservice_id text        -- Service affiliation
)

-- Social graph tracking
users_who_share_private_rooms (
    user_id text,
    other_user_id text,      -- Social relationships
    room_id text
)

users_in_public_rooms (
    user_id text,
    room_id text             -- Public affiliations
)
```

### Privacy Implications
1. **Complete social graphs visible**: Homeservers know who communicates with whom
2. **Behavioral profiling**: Typing, reading, online patterns exposed
3. **Temporal analysis**: Message timing reveals communication patterns
4. **Device tracking**: Long-term surveillance via device lists
5. **Geolocation**: IP addresses enable location tracking
6. **Cross-server correlation**: Multiple servers see same metadata

## Deployment Characteristics

### Server Implementations
- **Synapse**: Python→Rust, mature, resource-intensive
- **Dendrite**: Go, efficient, modular, beta status
- **Continuwuity**: Rust, lightweight, actively developed

### Infrastructure Requirements
- Domain name with DNS configuration
- Valid TLS certificate (trusted CA)
- Database engine (PostgreSQL recommended)
- Reverse proxy
- Storage for message history
- Bandwidth for federation

### Operational Complexity
- **Level**: Medium-High
- Regular software updates required
- Database maintenance and backups
- Certificate management
- Federation troubleshooting
- Monitoring and scaling

## Key Security Considerations

### Strengths
1. Strong cryptographic primitives (Curve25519, Ed25519, AES-256)
2. Well-vetted protocols (based on Signal's Double Ratchet)
3. Federated architecture resists centralization
4. Device-based key management enables device revocation
5. Cross-signing provides identity verification
6. No single point of failure for rooms

### Weaknesses
1. **Significant metadata exposure** even with E2EE
2. No built-in anonymity or Tor integration
3. Megolm lacks backward secrecy
4. Deployment and operational complexity
5. Federation exposes data to multiple servers
6. E2EE not mandatory or universal
7. IP addresses and behavioral data fully visible
8. Message replays possible without proper protection

### Recommendations
1. Always enable E2EE for sensitive communications
2. Verify device identities via cross-signing
3. Understand metadata exposure limitations
4. Choose privacy-focused homeserver providers
5. Consider additional privacy measures (Tor, anonymous hosting)
6. Regularly audit and manage device lists
7. Use Megolm session rotation for group chats
8. Be aware of what homeservers can see even with encryption

## Protocol Maturity
- **Specification**: Comprehensive, well-documented
- **Implementations**: Multiple production-ready servers
- **Clients**: Mature ecosystem with cross-platform support
- **Security**: Strong cryptography, limited metadata protection
- **Adoption**: Widely deployed in privacy-focused communities