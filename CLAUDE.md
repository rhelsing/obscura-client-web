# Claude Code Context

## Project Overview
Obscura Web Client - a Signal Protocol encrypted messaging client.

## Related Repositories

### Server (IMPORTANT!)
**When debugging server-related issues, ALWAYS check the server code:**
- **Repo:** https://github.com/barrelmaker97/obscura-server
- **OpenAPI Spec:** https://obscura.barrelmaker97.dev/openapi.yaml

Key server files for crypto/auth issues:
- `src/core/auth.rs` - `verify_signature()` function
- `src/core/key_service.rs` - Key upload and validation
- `src/api/auth.rs` - Registration endpoint

### Proto Definitions
- **Repo:** https://github.com/barrelmaker97/obscura-proto
- Local submodule at `public/proto/`

## Signal Protocol Keys

libsignal-protocol-typescript produces:
- **Public keys:** 33 bytes (0x05 Curve25519 type prefix + 32 bytes)
- **Private keys:** 32 bytes
- **Signatures:** 64 bytes (Ed25519)

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
- `test-keys.js` - Standalone key format debugging script

## Debugging Key/Signature Issues

Run the test script to debug key formats:
```bash
node test-keys.js
```

This tests various combinations of 32/33-byte keys against the server.
