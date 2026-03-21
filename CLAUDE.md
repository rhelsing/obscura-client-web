# Claude Code Context

@README.md

## Project Overview
Obscura Web Client - a Signal Protocol encrypted messaging client.

## Related Repositories

### Server (IMPORTANT!)
**When debugging server-related issues, ALWAYS check the server code:**
- **Repo:** https://github.com/barrelmaker97/obscura-server
- **OpenAPI Spec:** `$VITE_API_URL/openapi.yaml`

Key server files for crypto/auth issues:
- `src/core/auth.rs` - `verify_signature()` function
- `src/core/key_service.rs` - Key upload and validation
- `src/api/auth.rs` - Registration endpoint

### Proto Definitions

All proto files live in `public/proto/` (loaded at runtime by protobufjs):

**Server Proto** (`public/proto/obscura/v1/obscura.proto`):
- Upstream reference: https://github.com/barrelmaker97/obscura-proto
- OpenAPI spec at `$VITE_API_URL/openapi.yaml`
- Defines: `WebSocketFrame`, `EnvelopeBatch`, `Envelope`, `AckMessage`, `SendMessageRequest`, `SendMessageResponse`

**Client Proto** (`public/proto/v2/client.proto`):
- Client-only, server never sees this
- Defines: `EncryptedMessage`, `ClientMessage` with types TEXT, IMAGE, FRIEND_REQUEST, FRIEND_RESPONSE

## Signal Protocol Keys

libsignal-protocol-typescript produces:
- **Public keys:** 33 bytes (0x05 Curve25519 type prefix + 32 bytes)
- **Private keys:** 32 bytes
- **Signatures:** 64 bytes (XEdDSA - Curve25519 converted to Ed25519 for signing)

The 0x05 prefix is a type identifier. Server may expect 32-byte raw keys.

## Key Files

### Crypto
- `src/lib/crypto.js` - Key generation, prekey replenishment
- `src/lib/signalStore.js` - IndexedDB storage for Signal keys
- `src/lib/sessionManager.js` - Signal session encryption/decryption

### API
- `src/api/client.js` - HTTP API client
- `src/api/gateway.js` - WebSocket connection

### Testing
- `test/helpers/testClient.js` - E2E test client with real crypto
- `test/smoke/` - Standalone debugging scripts (test-keys.js, test-xeddsa.js, etc.)

## Testing

```bash
# E2E tests (requires server)
npm run test:e2e

# Browser tests (Playwright)
npm run test:browser

# Debug key formats against server
node test/smoke/test-keys.js
```
