# Security Analysis: Shell User Multi-Device Architecture

> Formal security analysis and literature review for the Obscura multi-device protocol.
> This document identifies security properties, compares to prior work, and outlines what remains to be formally proven.

**Version:** 1.0.0-draft
**Status:** Draft for Academic Review

---

## 1. Executive Summary

The Obscura Shell User architecture introduces a novel approach to multi-device end-to-end encrypted messaging where:

1. **The server has zero knowledge of device relationships** — Each device appears as an independent user
2. **Device topology is hidden in E2E-encrypted messages** — Peers learn about devices via `DeviceAnnounce`, not the server
3. **Each device has independent Signal Protocol keys** — Compromising one device doesn't expose others' session keys
4. **Revocation requires offline secret** — The recovery phrase is never stored on-device

This represents a stricter threat model than Signal's Sesame protocol, trading some usability for stronger metadata privacy.

---

## 2. Threat Model

### 2.1 Adversary Capabilities

We consider adversaries with the following capabilities:

| Adversary | Capabilities | Examples |
|-----------|-------------|----------|
| **Passive Server** | Observes all server traffic, metadata, account data | Compromised cloud provider |
| **Active Server** | Above + can modify/inject server responses | Nation-state with legal access |
| **Network Observer** | Observes encrypted traffic patterns, timing, IP addresses | ISP, network tap |
| **Device Compromise** | Full access to a single device's storage and keys | Stolen phone, malware |
| **Multi-Device Compromise** | Access to multiple (but not all) user devices | Sophisticated attacker |

### 2.2 Security Goals

| Property | Definition | Status |
|----------|------------|--------|
| **Message Confidentiality** | Only sender and recipient can read message content | Inherited from Signal Protocol |
| **Message Integrity** | Messages cannot be modified without detection | Inherited from Signal Protocol |
| **Forward Secrecy** | Past messages protected if current keys compromised | Inherited from Double Ratchet |
| **Post-Compromise Security** | Future messages protected after compromise ends | Claimed (requires proof) |
| **Device Topology Privacy** | Server cannot learn which devices belong to same user | **Novel claim** |
| **Device Enumeration Resistance** | Server cannot enumerate a user's devices | **Novel claim** |
| **Revocation Integrity** | Only legitimate user can revoke devices | Claimed via recovery phrase |

### 2.3 Out of Scope

- **Traffic analysis resistance** — Timing/size correlation may link devices
- **Endpoint security** — Malware with root access defeats all software protections
- **Social engineering** — User coerced to reveal recovery phrase
- **Quantum adversaries** — Current implementation uses classical crypto

---

## 3. Protocol Description

### 3.1 Account Structure

```
┌─────────────────────────────────────────────────────────────┐
│                     SERVER VIEW                              │
├─────────────────────────────────────────────────────────────┤
│  Account: alice         (shell - no keys, password only)    │
│  Account: alice_abc123  (device 1 - Signal keys)            │
│  Account: alice_def456  (device 2 - Signal keys)            │
│                                                              │
│  Server sees THREE UNRELATED ACCOUNTS                        │
└─────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────┐
│                     PEER VIEW                                │
├─────────────────────────────────────────────────────────────┤
│  Alice (P2P Identity: Ed25519 pubkey)                       │
│    ├── Device: alice_abc123 (Signal Key A)                  │
│    └── Device: alice_def456 (Signal Key B)                  │
│                                                              │
│  Learned via E2E-encrypted DeviceAnnounce messages          │
└─────────────────────────────────────────────────────────────┘
```

### 3.2 Key Hierarchy

```
User Identity
├── Shell Account
│   └── Password (Argon2 hash stored on server)
│
├── P2P Identity (Ed25519) — shared across devices
│   ├── Public Key (32 bytes) — shared with friends
│   └── Private Key (64 bytes) — stored on each device
│
├── Recovery Keypair (Ed25519) — derived from BIP39 mnemonic
│   ├── Public Key (32 bytes) — stored on devices, shared with friends
│   └── Private Key — NEVER STORED, derived on-demand from 12-word phrase
│
└── Per-Device
    ├── Device UUID (128 bits)
    ├── Signal Identity Key (Curve25519)
    ├── Signed PreKey (Curve25519 + XEdDSA signature)
    └── One-Time PreKeys (Curve25519)
```

### 3.3 Critical Invariants

1. **Shell account has no cryptographic keys** — Only reserves namespace
2. **Device accounts are unlinkable by server** — No shared identifiers
3. **P2P identity binds devices** — Communicated only via E2E messages
4. **Recovery phrase is offline** — Only secret that can revoke devices

---

## 4. Comparison to Prior Work

### 4.1 Signal Sesame Protocol

| Aspect | Signal Sesame | Obscura Shell |
|--------|---------------|---------------|
| Identity Key | **Shared** across devices | **Independent** per device |
| Server Knowledge | Knows device list per account | Sees unrelated accounts |
| Device Linking | Server mediates | P2P via E2E messages |
| Revocation | Server-side removal | P2P announce + recovery key |
| PCS Scope | Per-session | Per-device (stronger isolation) |

**Key Insight:** Signal's Sesame protocol supports per-device identity keys but Signal-the-app uses shared identity keys. Research by Jost et al. ([2021](https://eprint.iacr.org/2021/626.pdf)) showed this leads to PCS violations in multi-device settings.

### 4.2 WhatsApp Multi-Device

WhatsApp moved from a "leader device" model to per-device identity keys in 2021. However:
- Server still maintains device list per account
- Device correlation is trivial for server operator
- Formal analysis by Albrecht et al. ([EUROCRYPT 2025](https://eprint.iacr.org/2025/794.pdf)) examines group messaging security

### 4.3 Messaging Layer Security (MLS)

MLS ([RFC 9420](https://datatracker.ietf.org/doc/rfc9420/)) is the IETF standard for group E2E encryption:
- Designed for large groups (up to 50,000 members)
- Supports multi-device via "clients" concept
- Server typically knows group membership

**Obscura's Contribution:** MLS doesn't address device topology hiding — server knows group structure.

### 4.4 Metadata-Private Messaging

| System | Approach | Trade-offs |
|--------|----------|------------|
| **Sealed Sender** ([Signal](https://signal.org/blog/sealed-sender/)) | Blind delivery tokens | Server learns recipient, not sender |
| **Improving Sealed Sender** ([NDSS 2021](https://www.ndss-symposium.org/ndss-paper/improving-signals-sealed-sender/)) | Blind signatures for sender anonymity | Still reveals conversation flow |
| **Boomerang** ([NSDI 2023](https://www.usenix.org/system/files/nsdi23-jiang.pdf)) | Hardware enclaves | Requires TEE trust |
| **PingPong** ([2025](https://arxiv.org/html/2504.19566v1)) | Notify-before-retrieval | Complex infrastructure |
| **Obscura Shell** | Device topology in E2E messages | No sender/receiver anonymity |

**Key Insight:** Obscura doesn't hide who talks to whom (like Sealed Sender), but it hides *which devices* belong to the same user — a different and complementary metadata protection.

### 4.5 Decentralized Identity

Related work on decentralized identifiers (DIDs) and peer-to-peer key distribution:
- [DIDComm over libp2p](https://medium.com/uport/didcomm-messaging-through-libp2p-cffe0f06a062) — P2P messaging with decentralized identity
- [Decentralized Identifiers for P2P Service Discovery](https://dl.ifip.org/db/conf/networking/networking2021/1570714336.pdf) — DIDs for peer discovery

Obscura's P2P identity (Ed25519) serves a similar role but within the context of a server-mediated transport.

---

## 5. Security Properties Analysis

### 5.1 Device Topology Privacy (Novel Claim)

**Claim:** A passive server adversary cannot determine which device accounts belong to the same user.

**Informal Argument:**
1. Shell account `alice` and device accounts `alice_abc123`, `alice_def456` share no cryptographic material visible to server
2. Device UUIDs are random (128-bit), not derived from user identity
3. Password being the same is not observable (Argon2 hash differs per account due to unique salts)
4. Device linking occurs via E2E-encrypted `DeviceLinkApproval` messages

**What Needs Proof:**
- Formal indistinguishability game: Can adversary distinguish (alice, alice_abc123, alice_def456) as same-user vs. three unrelated users?
- Must account for timing correlation (all three registered in sequence)
- Must account for username prefix pattern (`alice_*`)

**Potential Weakness:** Username prefix `{username}_{uuid}` leaks that device accounts are related to shell. Consider random device usernames in future versions.

### 5.2 Post-Compromise Security

**Claim:** Compromising device A does not compromise messages encrypted for device B.

**Informal Argument:**
1. Each device has independent Signal Protocol keys
2. Sessions are per-device, not shared
3. P2P identity private key on compromised device cannot forge DeviceAnnounce (signature checked by recipients)

**Comparison to Signal:** Research ([Jost et al., 2021](https://eprint.iacr.org/2021/626.pdf)) showed Signal's shared identity key allows attacker to register new device after compromise, violating PCS. Obscura's per-device keys avoid this.

**What Needs Proof:**
- Formal model of multi-device PCS as in [Cremers et al., 2016](https://eprint.iacr.org/2016/221.pdf)
- Prove that DeviceAnnounce mechanism doesn't introduce PCS violations
- Analyze: Can attacker with device A's keys inject malicious DeviceAnnounce?

### 5.3 Revocation Security

**Claim:** Only the holder of the 12-word recovery phrase can revoke devices.

**Informal Argument:**
1. `DeviceAnnounce` with `is_revocation: true` must be signed with recovery private key
2. Recovery private key is derived from BIP39 mnemonic, never stored on device
3. Peers verify revocation signature against known `recoveryPublicKey`

**BIP39 Security:**
- 128-bit entropy (12 words) provides 2^128 security against brute force
- PBKDF2 with 2048 iterations provides moderate protection against offline attacks
- Consider increasing iterations (e.g., 100,000) for stronger security

**What Needs Proof:**
- Formal model of revocation: Adversary with device access cannot forge revocation
- Analyze replay attacks: Can old DeviceAnnounce be replayed?
- Timestamp freshness: How do peers reject stale announcements?

### 5.4 Device Linking Security

**Claim:** Device linking requires physical proximity (QR code) and E2E encryption.

**Informal Argument:**
1. New device generates random challenge in link code
2. Existing device must echo challenge in `DeviceLinkApproval`
3. Approval sent via Signal-encrypted message (session established via prekey bundle)

**What Needs Proof:**
- MITM resistance: Can attacker intercept QR code and link malicious device?
- Challenge entropy: 128 bits sufficient against online guessing
- Time window: How long is link code valid?

---

## 6. Attack Surface Analysis

### 6.1 Traffic Analysis

**Threat:** Network observer correlates devices by traffic patterns.

**Attack Vectors:**
- **Timing correlation:** Devices of same user online at similar times
- **IP correlation:** Devices connect from same IP/network
- **Message timing:** Self-sync messages create observable patterns

**Relevant Research:**
- [Practical Traffic Analysis Attacks on Secure Messaging](https://arxiv.org/abs/2005.00508) (NDSS 2020)
- COLD attack achieves 90%+ hit rate linking communication partners

**Mitigations (not implemented):**
- Constant-rate dummy traffic
- Randomized self-sync delays
- Tor/VPN for transport

**Recommendation:** Document this limitation clearly. Traffic analysis resistance requires fundamentally different architecture (mix networks, PIR).

### 6.2 Username Pattern Leakage

**Threat:** Device username `alice_abc123` reveals association with shell `alice`.

**Attack:** Server operator runs `SELECT * FROM users WHERE username LIKE 'alice_%'`

**Mitigation Options:**
1. Random device usernames (no prefix relationship)
2. Server-side hashing of usernames
3. Different authentication mechanism

**Recommendation:** Future protocol version should use unrelated device usernames.

### 6.3 DeviceAnnounce Injection

**Threat:** Attacker injects malicious DeviceAnnounce to add attacker-controlled device.

**Current Protection:**
- DeviceAnnounce is E2E encrypted (attacker can't inject without session)
- Signature verification (device key for additions, recovery key for revocations)

**Potential Attack:**
1. Attacker compromises device A
2. Extracts P2P identity private key
3. Sends DeviceAnnounce adding attacker's device to all contacts

**Analysis:** This is a valid attack! P2P identity key is on-device, so compromise allows device injection.

**Mitigation Options:**
1. Require challenge-response for device additions (recipient must approve)
2. Rate limit DeviceAnnounce (e.g., max 1 new device per day)
3. User notification when device list changes

**Recommendation:** This needs formal analysis and protocol revision.

### 6.4 Recovery Phrase Attacks

**Threat:** Attacker obtains recovery phrase and revokes all devices.

**Attack Vectors:**
- Physical theft of written phrase
- Social engineering
- Shoulder surfing during display

**Current Protection:**
- Phrase shown only once, then deleted
- 128-bit entropy against guessing

**Recommendation:** Consider Shamir Secret Sharing for recovery (2-of-3 or 3-of-5).

---

## 7. Formal Verification Roadmap

To make this protocol academically defensible, the following formal work is needed:

### 7.1 Security Model

Define formal model extending:
- Multi-stage AKE model from [Cohn-Gordon et al., 2016](https://eprint.iacr.org/2016/1013.pdf)
- Device-Oriented Group Messaging (DOGM) from [Matrix analysis](https://eprint.iacr.org/2023/1300.pdf)
- Post-Compromise Security definitions from [Cremers et al., 2016](https://eprint.iacr.org/2016/221.pdf)

### 7.2 Proofs Required

| Property | Proof Technique | Estimated Difficulty |
|----------|-----------------|---------------------|
| Device Topology Privacy | Indistinguishability game | Medium |
| Multi-device PCS | Reduction to Signal PCS | Medium |
| Revocation Integrity | Unforgeability under CMA | Low |
| Device Link Security | Authenticated key exchange proof | Medium |
| DeviceAnnounce Integrity | Signature unforgeability + freshness | Medium |

### 7.3 Recommended Tools

- **TAMARIN Prover** — Used for Signal analysis, can model multi-device
- **ProVerif** — Automated verification, good for protocol logic
- **CryptoVerif** — Computational soundness proofs

### 7.4 Symbolic vs. Computational

Initial analysis can use symbolic model (TAMARIN/ProVerif). Full paper should include computational reduction to:
- Ed25519 signature security (SUF-CMA)
- Signal Protocol security (existing proofs)
- BIP39/PBKDF2 security

---

## 8. Publication Strategy

### 8.1 Venue Options

| Venue | Type | Fit | Deadline (typical) |
|-------|------|-----|-------------------|
| **USENIX Security** | Top-tier | Excellent (systems + crypto) | February, June, October |
| **IEEE S&P (Oakland)** | Top-tier | Good (needs strong proofs) | April, August, December |
| **CCS** | Top-tier | Good (applied crypto) | January, May |
| **NDSS** | Top-tier | Excellent (practical security) | April, July |
| **PETS** | Focused | Excellent (privacy focus) | February, May, August, November |
| **EuroS&P** | Regional top | Good (more accessible) | November |

### 8.2 Paper Structure

1. **Introduction** — Multi-device E2E encryption leaks device topology
2. **Background** — Signal Protocol, Sesame, metadata privacy
3. **Threat Model** — Define server-blind multi-device goal
4. **Protocol Design** — Shell account separation, P2P identity
5. **Security Analysis** — Formal model, proofs
6. **Implementation** — Performance, code availability
7. **Evaluation** — Overhead vs. Signal, usability study
8. **Discussion** — Limitations, traffic analysis, future work
9. **Related Work** — Comprehensive comparison

### 8.3 Novelty Claims

The paper's core contributions should be:

1. **Server-Blind Device Topology** — First protocol where server cannot enumerate user's devices
2. **P2P Device Discovery** — Device announcements via E2E messages, not server
3. **Isolated Device Compromise** — Per-device keys provide stronger PCS than shared identity
4. **Offline Revocation Authority** — Recovery phrase model for device management

---

## 9. Open Questions

### 9.1 Theoretical

1. Can we achieve device topology privacy with formal indistinguishability proof?
2. What is the exact PCS guarantee in multi-device setting with per-device keys?
3. How to model DeviceAnnounce freshness and replay resistance?
4. Is the recovery phrase model stronger than hardware-bound revocation?

### 9.2 Practical

1. Username prefix pattern — should device usernames be fully random?
2. DeviceAnnounce spam — how to rate-limit without server knowledge?
3. Device verification UX — how do users verify new devices were legitimately added?
4. Recovery phrase UX — is 12 words the right tradeoff?

### 9.3 Future Extensions

1. **Group messaging** — Extend to groups while preserving device topology privacy
2. **Traffic analysis resistance** — Add padding/dummy traffic
3. **Sealed sender integration** — Combine with sender anonymity
4. **Post-quantum** — Migrate to PQ-secure signatures (e.g., SPHINCS+, Dilithium)

---

## 10. References

### Core Protocol Analysis

- Cohn-Gordon, K., Cremers, C., Dowling, B., Garratt, L., & Stebila, D. (2017). [A Formal Security Analysis of the Signal Messaging Protocol](https://eprint.iacr.org/2016/1013.pdf). *IEEE EuroS&P*.

- Cremers, C., Cohn-Gordon, K., & Garratt, L. (2016). [On Post-Compromise Security](https://eprint.iacr.org/2016/221.pdf). *IEEE CSF*.

- Jost, D., Maurer, U., & Mularczyk, M. (2021). [Help, my Signal has bad Device! Breaking the Signal Messenger's Post-Compromise Security](https://eprint.iacr.org/2021/626.pdf). *IACR ePrint*.

### Multi-Device Analysis

- Albrecht, M., Dowling, B., & Jones, D. (2025). [Formal Analysis of Multi-Device Group Messaging in WhatsApp](https://eprint.iacr.org/2025/794.pdf). *EUROCRYPT*.

- Signal Foundation. [The Sesame Algorithm](https://signal.org/docs/specifications/sesame/). *Signal Specifications*.

### Metadata Privacy

- Tyagi, N., et al. (2021). [Improving Signal's Sealed Sender](https://www.ndss-symposium.org/ndss-paper/improving-signals-sealed-sender/). *NDSS*.

- Jiang, Y., et al. (2023). [Boomerang: Metadata-Private Messaging under Hardware Trust](https://www.usenix.org/system/files/nsdi23-jiang.pdf). *NSDI*.

- Angel, S., & Setty, S. (2016). [Unobservable Communication over Fully Untrusted Infrastructure](https://www.usenix.org/system/files/conference/osdi16/osdi16-angel.pdf). *OSDI*.

### Traffic Analysis

- Bahramali, A., et al. (2020). [Practical Traffic Analysis Attacks on Secure Messaging Applications](https://arxiv.org/abs/2005.00508). *NDSS*.

### Standards

- Barnes, R., et al. (2023). [The Messaging Layer Security (MLS) Protocol](https://datatracker.ietf.org/doc/rfc9420/). *RFC 9420*.

- Palatinus, M., et al. (2013). [BIP39: Mnemonic code for generating deterministic keys](https://github.com/bitcoin/bips/blob/master/bip-0039.mediawiki). *Bitcoin Improvement Proposals*.

---

## 11. Conclusion

The Obscura Shell User architecture provides a novel approach to multi-device E2E encryption with stronger metadata privacy than existing deployed systems. The core insight — separating namespace reservation from cryptographic identity, and communicating device topology only via E2E messages — is simple but effective.

To be academically defensible, the protocol requires:
1. **Formal security model** extending existing multi-device AKE models
2. **Proofs** of device topology privacy, PCS, and revocation integrity
3. **Analysis** of the DeviceAnnounce injection attack
4. **Clear documentation** of traffic analysis limitations

The protocol represents a meaningful contribution to the secure messaging literature, particularly for threat models where server compromise is a realistic concern.

---

*Document generated for academic review. Implementation at: https://github.com/[repo]*
