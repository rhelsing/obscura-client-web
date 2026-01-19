# Client-Side Encryption with Signal Protocol

## Overview

Implemented end-to-end encryption using the Signal Protocol (X3DH + Double Ratchet) via `@privacyresearch/libsignal-protocol-typescript`.

## Library Choice

```bash
npm install @privacyresearch/libsignal-protocol-typescript
```

**Why this library:**
- The official `libsignal-protocol-javascript` is deprecated
- This is a maintained TypeScript fork with the same API
- Uses Curve25519 (required for Signal Protocol)
- Works in browsers via Web Crypto API

## Key Learnings

### 1. Server Returns Byte Arrays, Not Base64

The server API returns keys as **arrays of byte values**, not base64 strings:

```json
{
  "identityKey": [5, 179, 63, 149, 41, ...],
  "signedPreKey": {
    "keyId": 1,
    "publicKey": [5, 95, 70, 207, ...],
    "signature": [16, 198, 157, ...]
  },
  "oneTimePreKey": {
    "keyId": 3,
    "publicKey": [5, 89, 83, ...]
  }
}
```

**Solution:** Universal converter that handles all formats:

```javascript
function toArrayBuffer(input) {
  if (Array.isArray(input)) {
    return new Uint8Array(input).buffer;
  }
  if (input instanceof ArrayBuffer) {
    return input;
  }
  if (input instanceof Uint8Array) {
    return input.buffer.slice(input.byteOffset, input.byteOffset + input.byteLength);
  }
  if (typeof input === 'string') {
    // Handle base64
    let b64 = input.replace(/-/g, '+').replace(/_/g, '/');
    while (b64.length % 4 !== 0) b64 += '=';
    const binary = atob(b64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes.buffer;
  }
  throw new Error(`Cannot convert to ArrayBuffer: ${typeof input}`);
}
```

### 2. Ciphertext Body is a Binary String

The library's `cipher.encrypt()` returns:

```typescript
interface MessageType {
  type: number;      // 1 = WhisperMessage, 3 = PreKeyWhisperMessage
  body?: string;     // NOT base64 - it's a binary string
  registrationId?: number;
}
```

The `body` is created using `String.fromCharCode()` on each byte. **Do not use `atob()`** - convert directly:

```javascript
const bodyBytes = new Uint8Array(ciphertext.body.length);
for (let i = 0; i < ciphertext.body.length; i++) {
  bodyBytes[i] = ciphertext.body.charCodeAt(i);
}
```

### 3. Signal vs Proto Message Types

| Signal Protocol | Value | Proto EncryptedMessage.Type |
|-----------------|-------|----------------------------|
| PreKeyWhisperMessage | 3 | TYPE_PREKEY_MESSAGE (1) |
| WhisperMessage | 1 | TYPE_ENCRYPTED_MESSAGE (2) |

```javascript
const protoType = ciphertext.type === 3 ? 1 : 2;
```

### 4. SignalProtocolStore Interface

The library requires implementing `StorageType`:

```typescript
interface StorageType {
  getIdentityKeyPair(): Promise<KeyPairType | undefined>;
  getLocalRegistrationId(): Promise<number | undefined>;
  isTrustedIdentity(identifier: string, identityKey: ArrayBuffer, direction: Direction): Promise<boolean>;
  saveIdentity(encodedAddress: string, publicKey: ArrayBuffer): Promise<boolean>;
  loadPreKey(keyId: string | number): Promise<KeyPairType | undefined>;
  storePreKey(keyId: number | string, keyPair: KeyPairType): Promise<void>;
  removePreKey(keyId: number | string): Promise<void>;
  loadSignedPreKey(keyId: number | string): Promise<KeyPairType | undefined>;
  storeSignedPreKey(keyId: number | string, keyPair: KeyPairType): Promise<void>;
  removeSignedPreKey(keyId: number | string): Promise<void>;
  loadSession(encodedAddress: string): Promise<SessionRecordType | undefined>;
  storeSession(encodedAddress: string, record: SessionRecordType): Promise<void>;
}
```

We implemented this with IndexedDB for persistent storage.

### 5. Key Generation with KeyHelper

```javascript
import { KeyHelper } from '@privacyresearch/libsignal-protocol-typescript';

const identityKeyPair = await KeyHelper.generateIdentityKeyPair();
const registrationId = KeyHelper.generateRegistrationId();
const signedPreKey = await KeyHelper.generateSignedPreKey(identityKeyPair, 1);
const preKey = await KeyHelper.generatePreKey(1);
```

Keys are Curve25519, not ECDSA. The `pubKey` and `privKey` are `ArrayBuffer`.

### 6. Session Establishment (X3DH)

```javascript
import { SessionBuilder } from '@privacyresearch/libsignal-protocol-typescript';

const device = {
  identityKey: toArrayBuffer(bundle.identityKey),
  registrationId: bundle.registrationId,
  signedPreKey: {
    keyId: bundle.signedPreKey.keyId,
    publicKey: toArrayBuffer(bundle.signedPreKey.publicKey),
    signature: toArrayBuffer(bundle.signedPreKey.signature),
  },
  preKey: bundle.oneTimePreKey ? {
    keyId: bundle.oneTimePreKey.keyId,
    publicKey: toArrayBuffer(bundle.oneTimePreKey.publicKey),
  } : undefined,
};

const sessionBuilder = new SessionBuilder(store, address);
await sessionBuilder.processPreKey(device);
```

### 7. Encryption/Decryption

```javascript
import { SessionCipher } from '@privacyresearch/libsignal-protocol-typescript';

const cipher = new SessionCipher(store, address);

// Encrypt (input must be ArrayBuffer)
const ciphertext = await cipher.encrypt(plaintextArrayBuffer);

// Decrypt PreKeyWhisperMessage (first message)
const plaintext = await cipher.decryptPreKeyWhisperMessage(contentBuffer, 'binary');

// Decrypt WhisperMessage (subsequent messages)
const plaintext = await cipher.decryptWhisperMessage(contentBuffer, 'binary');
```

## Architecture

```
┌─────────────────┐     ┌─────────────────┐
│   landing.js    │     │   gateway.js    │
│  (UI/Messages)  │────▶│  (WebSocket)    │
└────────┬────────┘     └────────┬────────┘
         │                       │
         ▼                       ▼
┌─────────────────┐     ┌─────────────────┐
│ sessionManager  │     │ EncryptedMessage│
│ (encrypt/decrypt)│    │    (proto)      │
└────────┬────────┘     └─────────────────┘
         │
         ▼
┌─────────────────┐     ┌─────────────────┐
│  signalStore    │     │    crypto.js    │
│   (IndexedDB)   │     │ (key generation)│
└─────────────────┘     └─────────────────┘
```

## Files

- `src/lib/signalStore.js` - IndexedDB implementation of SignalProtocolStore
- `src/lib/sessionManager.js` - Session management, encrypt/decrypt
- `src/lib/crypto.js` - Key generation using KeyHelper
- `src/pages/landing.js` - Integration points for send/receive

## Gotchas

1. **Uint8Array.buffer sharing**: When slicing, use `buffer.slice(byteOffset, byteOffset + byteLength)` to get a copy, not a view
2. **Session caching**: Cache `SessionCipher` instances - creating new ones is expensive
3. **One-time prekeys**: Server may return `oneTimePreKey` instead of `preKey` - handle both
4. **First message**: Always check if session exists before encrypting - first message needs X3DH
5. **Direction enum**: `Direction.SENDING = 1`, `Direction.RECEIVING = 2` for `isTrustedIdentity()`
