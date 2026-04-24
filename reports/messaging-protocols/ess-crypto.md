# Element Server Suite: Cryptography & Network Summary

## Cryptographic Overview

### Core Protocols
- **Transport**: TLS 1.3 for all client-server and server-server communication
- **E2EE**: Olm (double ratchet) for 1:1, Megolm for group messaging
- **Key Exchange**: X25519 (Curve25519) elliptic curve Diffie-Hellman
- **Signatures**: Ed25519 for device identity and authentication
- **Symmetric**: AES-256-CTR encryption, HMAC-SHA-256 authentication

### Security Properties
- **Forward Secrecy**: Yes (via double ratchet in 1:1, limited in groups)
- **Future Secrecy**: Yes (1:1), Limited (groups)
- **Post-Compromise Security**: Yes (1:1 only)
- **Authentication**: Device-based via Ed25519 keys
- **Key Management**: Hierarchical with cross-signing for device verification

### Key Hierarchy
```
Root Identity Keys (long-term)
├── Fingerprint Keys (cross-signing)
├── Device Identity Keys (Ed25519)
└── One-time Prekeys (X25519)
```

## Network Architecture

### Protocol Stack
- **Application**: JSON over HTTP/HTTPS
- **Transport**: TCP
- **Security**: TLS 1.3

### Topology
- **Model**: Decentralized federation of homeservers
- **Discovery**: DNS SRV + .well-known/matrix/server
- **Identity**: @user:server.com format
- **Consistency**: Eventual consistency via event DAG

### Federation Security
- **Server Authentication**: TLS certificates
- **Trust Model**: Must trust participating servers
- **Attack Surface**: Malicious servers can disrupt rooms
- **Mitigation**: Server whitelisting, restricted federation

## Metadata Exposure

### Server-Visible Metadata
- Complete room membership and participant lists
- Message timing and communication patterns
- Room state changes and configuration
- Social graph structure (who communicates with whom)

### Federation Impact
- Each participating server sees complete metadata
- Cross-server rooms multiply exposure
- Historical metadata persists unless deleted
- Limited mitigation options available

### Notable Gap
Matrix lacks comprehensive metadata protection comparable to Signal's sealed sender protocol. Even perfect E2EE leaves extensive metadata visible.

## Security Assessment

### Strengths
- Strong cryptographic primitives (audited Olm/Megolm)
- Proven double ratchet algorithm
- Decentralized architecture with no single point of failure
- Cross-platform interoperability
- Independent security audits of core crypto libraries

### Weaknesses
- Extensive metadata leakage
- Group encryption compromises forward secrecy
- High operational complexity
- Large attack surface from protocol complexity
- Web client has inherent security limitations

### ESS Impact
- Does not modify underlying crypto model
- Adds operational convenience via Kubernetes packaging
- May concentrate metadata in enterprise deployments
- Introduces additional dependencies but no new trust boundaries

## Risk Profile

**Suitable For**: Organizations with strong DevOps expertise, moderate security requirements, needing data sovereignty and federation capabilities.

**Not Suitable For**: High-security environments requiring metadata protection, organizations without Kubernetes expertise, scenarios needing minimal operational overhead.

**Key Trade-off**: Federation and E2EE provide strong content protection at the cost of extensive metadata exposure and significant operational complexity.