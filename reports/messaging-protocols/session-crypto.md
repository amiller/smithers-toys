# Session Protocol: Crypto & Network Technical Summary

## Cryptographic Architecture

### Core Algorithms

**Primary Primitives**:
- **Ed25519**: Digital signatures (Twisted Edwards curve)
- **X25519**: Key exchange (Montgomery curve)
- **AES-256-GCM**: Symmetric encryption
- **BLAKE2b**: Cryptographic hashing
- **Poly1305**: Message authentication

**Key Relationship**:
```
Ed25519 Keypair (Identity)
    ↓
crypto_sign_ed25519_pk_to_curve25519()
    ↓
X25519 Public Key (Encryption)
crypto_sign_ed25519_sk_to_curve25519()
    ↓
X25519 Private Key (Decryption)
```

Single Ed25519 keypair serves both signing (identity) and encryption (messaging) purposes through cryptographic conversion.

### Message Encryption Process

**1:1 Messaging**:
```
Plaintext → Padding → [Msg || SenderPk || RecipientPk]
         ↓
    Ed25519 Signature
         ↓
[Msg || SenderPk || Signature]
         ↓
    X25519 Seal (crypto_box_seal)
         ↓
    Ciphertext
```

**Group Messaging**:
- Separate X25519 keypair per closed group
- Admins distribute keys via encrypted messages
- All members encrypt with group public key
- Regular key rotation for forward secrecy

### Session ID Format

**66-character hex strings**:
- `05xxxxxxxx...` → X25519 public key (1:1 messaging)
- `03xxxxxxxx...` → Ed25519 public key (closed groups)

**Generation**:
1. Generate Ed25519 keypair
2. Convert to X25519 for encryption
3. Add version prefix (0x05 or 0x03)
4. Share as Session ID

## Network Architecture

### Onion Routing (3-Hop Paths)

**Path Structure**:
```
Client → Guard Node → Middle Node → Edge Node → Storage Swarm
   ↑           ↑              ↑              ↑
   └────────────────┴──────────────────┘
         Only guard sees client IP
```

**Path Security**:
- **Guard nodes**: 2 per client, long-lived, tested for reliability
- **Middle nodes**: Randomly selected, exclude guard's /24 subnet
- **Edge nodes**: Random selection, must support required API version
- **Path failure threshold**: 3 failures triggers rebuild
- **Hops**: Fixed at 3 (ONION_REQUEST_HOPS = 3)

### Service Node Swarms

**Swarm Formation**:
- Deterministic assignment based on user's X25519 public key
- XOR distance metric distributes swarms across ID space
- Variable size (typically 10-20 nodes)
- Automatic rebalancing on node join/leave

**Redundancy**:
- Messages stored across multiple nodes in swarm
- No single point of failure
- Client can retrieve from any swarm member

### Blockchain Coordination

**Service Node Requirements**:
- Stake: 15,000 OXEN tokens
- Uptime: 90%+ minimum
- Storage/bandwidth: Sufficient capacity
- Registration: On-chain transaction with Ed25519 pubkey

**Reward System**:
- Per-block OXEN distribution to active nodes
- Uptime tracking on blockchain
- Automatic deregistration for failed nodes

## Metadata Exposure Analysis

### Service Node Visibility

**What Nodes CAN See**:
- ✓ Message timing and frequency
- ✓ Approximate message sizes
- ✓ Recipient Session IDs (queries)
- ✓ Request patterns and polling behavior
- ✓ Which Session IDs map to which swarms
- ✓ Client IPs (guard nodes only)

**What Nodes CANNOT See**:
- ✗ Message content (E2E encrypted)
- ✗ Contact lists/social graphs
- ✗ Private encryption keys
- ✗ Real-world identities (phone/email)
- ✗ Inter-user communication patterns (except via same node)

### Privacy Gaps

**Identifiable Information**:
- Persistent Session IDs (no rotation)
- Public key mathematical linkage
- Stable swarm assignment

**Traffic Analysis Risks**:
- Timing correlation across users
- Volume analysis (high/low activity)
- Swarm targeting for surveillance
- Multiple node operator collusion

## Key Security Properties

### Forward Secrecy
- Per-message ephemeral X25519 keys
- Regular group key rotation
- No persistent secrets on servers
- User-initiated message deletion

### Authentication
- Ed25519 signatures on all messages
- Sender identity verification
- Tamper detection
- Non-repudiation

### Anonymity
- 3-hop onion routing
- IP address hiding from storage nodes
- Guard node isolation
- No personal identifiers required

### Availability
- Swarm-based redundancy
- Offline message delivery
- Automatic path rebuilding
- Network-wide failure resilience

## Technical Stack

**Libraries**:
- `libsodium-wrappers-sumo` (desktop)
- `libsignal` (forked/customized)
- `curve25519-js` (JS operations)
- `libsession-util` (native bindings)

**Languages**:
- TypeScript (desktop client)
- Kotlin/Java (Android client)
- C++ (blockchain core)

**Protocols**:
- Custom Session Protocol (messaging)
- Onion Request v4 (routing)
- JSON-RPC 2.0 (service node API)
- Oxen blockchain P2P (coordination)

## Deployment Model

**Infrastructure**: Public service node network only
**Federation**: Not supported
**Self-hosting**: Clients only, no private swarms
**Sovereignty**: Limited (must use public network)
**Entry Barrier**: High (15k OXEN stake + infrastructure)

---

*Based on analysis of session-desktop v1.14.3, session-android (deprecated), and oxen-core repositories*