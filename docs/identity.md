# Obscura Identity Specification

> Source of truth for multi-device identity architecture.
> All implementation MUST match this spec exactly.

**Version:** 1.0.0-draft
**Status:** Draft

---

## Core Concept: Shell Account + Device Account

Each user has TWO types of server accounts:

| Type | Example | Purpose |
|------|---------|---------|
| **Shell Account** | `alice` | Reserves namespace, validates password, no keys |
| **Device Account** | `alice_abc123` | Has Signal keys, used for all app operations |

Server sees these as **completely unrelated users**. The link exists only in client storage.

---

## Account Structure

### Shell Account

```
username: "alice"
password: argon2(user_password)
keys: NONE
```

- Created during first device registration
- Reserves the username namespace
- Used ONLY for password validation before new device registration
- Never used for messaging or key operations

### Device Account

```
username: "alice_{deviceUUID_first8}"
password: argon2(user_password)  // Same password as shell
keys: {
  identityKey: Curve25519 (33 bytes with 0x05 prefix)
  registrationId: uint32
  signedPreKey: { keyId, publicKey, signature }
  oneTimePreKeys: [{ keyId, publicKey }, ...]
}
```

- Created per-device
- Used for all Signal Protocol operations
- Each device has unique Signal keys (forward secrecy)

---

## Registration Flow (First Device)

```
INPUT: username, password

1. POST /v1/users
   Body: { username: "{username}", password: "{password}" }
   Response: 201 Created
   → Shell account created

2. Generate:
   - deviceUUID = crypto.randomUUID() or 16 random bytes as hex
   - deviceUsername = "{username}_{deviceUUID[0:8]}"
   - signalKeys = generateSignalKeys()
   - p2pIdentity = generateEd25519Keypair()
   - recoveryPhrase = generateBIP39Mnemonic(128 bits) → 12 words
   - recoveryKeypair = deriveBIP39Keypair(recoveryPhrase)

3. POST /v1/users
   Body: {
     username: "{deviceUsername}",
     password: "{password}",
     identityKey: base64(signalKeys.identityKey),
     registrationId: signalKeys.registrationId,
     signedPreKey: {
       keyId: 1,
       publicKey: base64(signedPreKey.publicKey),
       signature: base64(signedPreKey.signature)
     },
     oneTimePreKeys: [
       { keyId: 1, publicKey: base64(...) },
       ...
     ]
   }
   Response: 201 Created
   → Device account created

4. Store in IndexedDB (deviceStore):
   {
     coreUsername: "{username}",
     deviceUsername: "{deviceUsername}",
     deviceUUID: "{deviceUUID}",
     p2pIdentity: {
       publicKey: Uint8Array(32),
       privateKey: Uint8Array(64)
     },
     recoveryPublicKey: Uint8Array(32),
     ownDevices: [{
       deviceUUID: "{deviceUUID}",
       serverUserId: "{deviceUsername}",
       deviceName: detectDeviceName(),
       signalIdentityKey: signalKeys.identityKey
     }]
   }

5. Display recovery phrase to user (ONCE):
   "Write down these 12 words. You will NEVER see them again."
   ┌─────────┬─────────┬─────────┐
   │ word1   │ word2   │ word3   │
   ├─────────┼─────────┼─────────┤
   │ word4   │ word5   │ word6   │
   ├─────────┼─────────┼─────────┤
   │ word7   │ word8   │ word9   │
   ├─────────┼─────────┼─────────┤
   │ word10  │ word11  │ word12  │
   └─────────┴─────────┴─────────┘

6. User confirms → DELETE recoveryPhrase from memory

7. Return: { success: true, deviceUsername, deviceUUID }
```

---

## Login Flow

```
INPUT: username, password

1. POST /v1/sessions
   Body: { username: "{username}", password: "{password}" }

   CASE: 401/404 Response
   → INVALID_CREDENTIALS
   → Show: "Invalid username or password"

   CASE: 200 Response (JWT for shell account)
   → Shell validates, continue to step 2

2. Check IndexedDB: deviceStore.get(coreUsername: "{username}")

   CASE: Found deviceUsername
   → POST /v1/sessions { username: "{deviceUsername}", password }
   → 200: EXISTING_DEVICE → Continue to app
   → 401: LOCAL_DEVICE_MISMATCH → Clear local, treat as NEW_DEVICE

   CASE: Not found
   → NEW_DEVICE
   → Begin device linking flow
```

### Login Outcomes

| Shell Login | Local Device | Device Login | Outcome |
|-------------|--------------|--------------|---------|
| FAIL | - | - | `INVALID_CREDENTIALS` |
| OK | Not found | - | `NEW_DEVICE` |
| OK | Found | OK | `EXISTING_DEVICE` |
| OK | Found | FAIL | `LOCAL_DEVICE_MISMATCH` |

---

## New Device Flow

```
PRECONDITION: Login returned NEW_DEVICE

1. Generate:
   - deviceUUID = crypto.randomUUID()
   - deviceUsername = "{coreUsername}_{deviceUUID[0:8]}"
   - signalKeys = generateSignalKeys()

2. POST /v1/users
   Body: { username: "{deviceUsername}", password, ...signalKeys }
   Response: 201 Created

3. Store partial identity in IndexedDB:
   {
     coreUsername: "{username}",
     deviceUsername: "{deviceUsername}",
     deviceUUID: "{deviceUUID}",
     p2pIdentity: null,        // PENDING - waiting for link
     recoveryPublicKey: null,  // PENDING
     ownDevices: [],           // PENDING
     linkPending: true
   }

4. Generate link code:
   linkData = {
     serverUserId: "{deviceUsername}",
     signalIdentityKey: base64(signalKeys.identityKey),
     challenge: base64(crypto.randomBytes(16))
   }
   linkCode = base58.encode(JSON.stringify(linkData))

5. Display:
   - QR code encoding linkCode
   - Copyable text of linkCode
   - Instructions: "Scan this on your existing device, or paste the code"

6. Connect WebSocket, wait for DEVICE_LINK_APPROVAL message

7. On receive DEVICE_LINK_APPROVAL:
   - Decrypt message
   - Import p2pIdentity, recoveryPublicKey, ownDevices, friends, sessions
   - Set linkPending: false
   - Continue to app
```

---

## Link Approval Flow (Existing Device)

```
PRECONDITION: User scans QR or pastes link code

1. Decode linkCode:
   linkData = JSON.parse(base58.decode(linkCode))
   Extract: serverUserId, signalIdentityKey, challenge

2. Fetch prekey bundle:
   GET /v1/keys/{serverUserId}

3. Establish Signal session with new device

4. Build DEVICE_LINK_APPROVAL message:
   {
     type: DEVICE_LINK_APPROVAL,
     p2pIdentity: {
       publicKey: myP2PPublicKey,
       privateKey: myP2PPrivateKey  // Encrypted in Signal message
     },
     recoveryPublicKey: myRecoveryPublicKey,
     challenge: linkData.challenge,
     ownDevices: [
       ...existingDevices,
       {
         deviceUUID: extractUUID(linkData.serverUserId),
         serverUserId: linkData.serverUserId,
         deviceName: "New Device",  // Will be updated
         signalIdentityKey: linkData.signalIdentityKey
       }
     ],
     friends: exportFriends(),
     sessions: exportSessions(),
     trustedIdentities: exportTrustedIdentities()
   }

5. Encrypt and send:
   POST /v1/messages/{serverUserId}
   Body: Signal-encrypted DEVICE_LINK_APPROVAL

6. Update local ownDevices list

7. Broadcast DEVICE_ANNOUNCE to all friends:
   For each friend device:
     POST /v1/messages/{friendDeviceServerUserId}
     Body: Signal-encrypted DEVICE_ANNOUNCE
```

---

## Device Announce Message

Sent to all friends when device list changes (add or revoke).

```protobuf
message DeviceAnnounce {
  repeated DeviceInfo devices = 1;  // Current full list
  uint64 timestamp = 2;
  bool is_revocation = 3;
  bytes signature = 4;  // Device key (add) or recovery key (revoke)
}

message DeviceInfo {
  string device_uuid = 1;
  string server_user_id = 2;
  string device_name = 3;
  bytes signal_identity_key = 4;
}
```

**Signature verification:**
- `is_revocation: false` → Verify with sender's device Signal key
- `is_revocation: true` → Verify with sender's recovery public key

---

## Device Revocation Flow

```
PRECONDITION: User wants to revoke a device

1. Prompt for 12-word recovery phrase

2. Derive recovery keypair:
   recoveryKeypair = deriveBIP39Keypair(phrase)

3. Verify:
   recoveryKeypair.publicKey === stored recoveryPublicKey
   FAIL → "Invalid recovery phrase"

4. Build DEVICE_ANNOUNCE:
   {
     devices: ownDevices.filter(d => d.deviceUUID !== revokedUUID),
     timestamp: Date.now(),
     is_revocation: true,
     signature: sign(devices + timestamp, recoveryKeypair.privateKey)
   }

5. Broadcast to all friends

6. Update local ownDevices list

7. Wipe recoveryKeypair from memory
```

---

## Fan-Out Messaging

When sending a message to a friend:

```
1. Get friend's device list from friendStore

2. For each friend device:
   - Ensure Signal session exists
   - Encrypt message for that device
   - POST /v1/messages/{friendDeviceServerUserId}

3. Self-sync to own devices:
   For each own device (except current):
   - Encrypt message
   - POST /v1/messages/{ownDeviceServerUserId}
```

---

## Attachment Encryption

```
UPLOAD:
1. contentKey = crypto.randomBytes(32)  // AES-256
2. nonce = crypto.randomBytes(12)       // GCM nonce
3. encryptedBlob = AES-256-GCM(content, contentKey, nonce)
4. contentHash = SHA256(content)
5. POST /v1/attachments { body: encryptedBlob }
   → Returns: { id, expiresAt }
6. Include in message (E2E encrypted):
   { attachmentId, contentKey, nonce, contentHash, mimeType }

DOWNLOAD:
1. GET /v1/attachments/{id} → encryptedBlob
2. content = AES-256-GCM-decrypt(encryptedBlob, contentKey, nonce)
3. Verify: SHA256(content) === contentHash
4. Return content
```

---

## Cryptographic Primitives

### Device UUID
- 16 random bytes formatted as UUID v4
- Or: `crypto.randomUUID()` where available

### P2P Identity (Ed25519)
- Generated via Web Crypto API
- Public key: 32 bytes
- Private key: 64 bytes (PKCS8 format) or 32 bytes (raw seed)
- Used for signing DeviceAnnounce messages

### Recovery Phrase (BIP39)
- 128 bits entropy → 12 words
- Wordlist: BIP39 English (2048 words)
- Derivation: PBKDF2-HMAC-SHA512, salt="mnemonic", iterations=2048
- Output: 64 bytes seed → first 32 bytes as Ed25519 seed

### Link Code (Base58)
- Bitcoin alphabet: `123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz`
- Encodes: JSON string of link data
- No checksum (link data has its own challenge)

### Signal Keys
- Identity key: Curve25519 with 0x05 prefix (33 bytes)
- Signed prekey: Curve25519 + XEdDSA signature (64 bytes)
- One-time prekeys: Curve25519

---

## IndexedDB Schema

### deviceStore (new)

```
Database: obscura_device_{coreUsername}

Stores:
  identity: {
    coreUsername: string,
    deviceUsername: string,
    deviceUUID: string,
    p2pPublicKey: Uint8Array(32),
    p2pPrivateKey: Uint8Array(64),
    recoveryPublicKey: Uint8Array(32),
    linkPending: boolean
  }

  ownDevices: [
    {
      deviceUUID: string,
      serverUserId: string,
      deviceName: string,
      signalIdentityKey: Uint8Array(33)
    }
  ]
```

### friendStore (extended)

```
friends: {
  userId: string,         // P2P identity (not server user ID)
  username: string,
  status: string,
  devices: [              // NEW
    {
      deviceUUID: string,
      serverUserId: string,
      deviceName: string,
      signalIdentityKey: Uint8Array(33)
    }
  ],
  recoveryPublicKey: Uint8Array(32),  // NEW - for verifying revocations
  createdAt: number,
  updatedAt: number
}
```

---

## Proto Definitions

### File: `src/identity/proto/device.proto`

```protobuf
syntax = "proto3";
package obscura.identity;

message DeviceLinkApproval {
  bytes p2p_public_key = 1;
  bytes p2p_private_key = 2;  // Encrypted in Signal envelope
  bytes recovery_public_key = 3;
  bytes challenge_response = 4;
  repeated DeviceInfo own_devices = 5;
  bytes friends_export = 6;      // Serialized friend list
  bytes sessions_export = 7;     // Serialized Signal sessions
  bytes trusted_ids_export = 8;  // Serialized trusted identities
}

message DeviceAnnounce {
  repeated DeviceInfo devices = 1;
  uint64 timestamp = 2;
  bool is_revocation = 3;
  bytes signature = 4;
}

message DeviceInfo {
  string device_uuid = 1;
  string server_user_id = 2;
  string device_name = 3;
  bytes signal_identity_key = 4;
}
```

---

## Server API (Existing - No Changes)

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/v1/users` | POST | Register new account |
| `/v1/sessions` | POST | Login, get JWT |
| `/v1/keys/{userId}` | GET | Fetch prekey bundle |
| `/v1/keys` | POST | Upload new keys |
| `/v1/messages/{recipientId}` | POST | Send encrypted message |
| `/v1/gateway` | WebSocket | Receive messages |
| `/v1/attachments` | POST | Upload attachment |
| `/v1/attachments/{id}` | GET | Download attachment |

Server sees shell and device accounts as unrelated users.
Server has no knowledge of device linking or P2P identity.

---

## Test Scenarios

Implementation MUST pass all scenarios:

### Scenario 1: First Device Registration
- Input: username="testuser", password="secret"
- Expected: Shell account created, device account created, recovery phrase shown
- Verify: Both accounts exist on server, can login to both

### Scenario 2: Existing Device Login
- Precondition: Device registered, IndexedDB has deviceUsername
- Input: username="testuser", password="secret"
- Expected: Shell login OK, device login OK, app launches
- Verify: No new accounts created

### Scenario 3: New Device Detection
- Precondition: Shell account exists, this device has no IndexedDB entry
- Input: username="testuser", password="secret"
- Expected: Shell login OK, detects NEW_DEVICE, shows link code
- Verify: New device account created on server

### Scenario 4: Wrong Password
- Input: username="testuser", password="wrongpassword"
- Expected: Shell login fails, show error
- Verify: No side effects

### Scenario 5: Unregistered User
- Input: username="newuser", password="anything"
- Expected: Shell login fails (user doesn't exist)
- Verify: Prompt to register

### Scenario 6: Device Link Approval
- Precondition: New device showing QR, existing device online
- Action: Existing device scans QR
- Expected: Session established, DEVICE_LINK_APPROVAL sent
- Verify: New device receives identity, can decrypt messages

### Scenario 7: Device Announce Broadcast
- Precondition: Device linked
- Expected: All friends receive DEVICE_ANNOUNCE
- Verify: Friends update fan-out list

### Scenario 8: Device Revocation
- Precondition: Multiple devices linked
- Input: 12-word recovery phrase
- Expected: DEVICE_ANNOUNCE (is_revocation=true) broadcast
- Verify: Revoked device removed from friends' fan-out

### Scenario 9: Fan-Out Send
- Precondition: Friend has 2 devices
- Action: Send message to friend
- Expected: Message sent to both friend devices
- Verify: Both devices receive message

### Scenario 10: Self-Sync
- Precondition: User has 2 devices
- Action: Send message from device A
- Expected: Message synced to device B
- Verify: Device B receives message

### Scenario 11: Attachment Encryption
- Action: Upload image
- Expected: Image encrypted before upload, key in E2E message
- Verify: Server cannot decrypt attachment

---

## Verification Checklist

Implementation is complete when:

- [ ] Shell account registration works
- [ ] Device account registration works
- [ ] Login detects EXISTING_DEVICE correctly
- [ ] Login detects NEW_DEVICE correctly
- [ ] Login rejects wrong password
- [ ] Login rejects unregistered user
- [ ] Device UUID generation is valid
- [ ] P2P identity generation works (Ed25519)
- [ ] Recovery phrase generation works (12 BIP39 words)
- [ ] Recovery keypair derivation is deterministic
- [ ] Link code encodes/decodes correctly (base58)
- [ ] Link approval message sends correctly
- [ ] New device receives and imports identity
- [ ] DeviceAnnounce broadcasts to friends
- [ ] Device revocation requires recovery phrase
- [ ] Revocation signature verifies with recovery key
- [ ] Fan-out sends to all friend devices
- [ ] Self-sync sends to own devices
- [ ] Attachment encryption works (AES-256-GCM)
- [ ] All test scenarios pass
- [ ] **Implementation matches this spec exactly**
