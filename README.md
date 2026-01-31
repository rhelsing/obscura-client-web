# Obscura Web Client


NEXT:
* Rails model ORM inspiration.. MVC?
* Schema versioning! - pushing out updates to schema.. does it wait and say youve got messages waiting sent from people on newer versions, update now? or auto update?

Web client for the [Obscura encrypted messaging server](https://github.com/barrelmaker97/obscura-server/).

Uses the [obscura-proto](https://github.com/barrelmaker97/obscura-proto) definitions as a git submodule.

## Prerequisites

- [nvm](https://github.com/nvm-sh/nvm) (Node Version Manager)
- Node.js v22

## Getting Started

1. **Clone with submodules**

   ```bash
   git clone --recursive https://github.com/YOUR_USERNAME/obscura-client-web.git
   cd obscura-client-web
   ```

   If you already cloned without `--recursive`:
   ```bash
   git submodule update --init
   ```

2. **Set Node.js version**

   ```bash
   nvm use v22
   ```

   If you don't have v22 installed:
   ```bash
   nvm install v22
   ```

3. **Install dependencies**

   ```bash
   npm install
   ```

4. **Configure the API endpoint**

   Create a `.env` file in the project root:

   ```bash
   VITE_API_URL=https://your-obscura-server.example.com
   ```

   Replace the URL with your Obscura server endpoint.

5. **Start the development server**

   ```bash
   npm run dev
   ```

   The app will be available at `http://localhost:5173`

## Proto Definitions

**Server proto** (submodule at `proto/`): Transport layer - `WebSocketFrame`, `Envelope`, `EncryptedMessage`

**Client proto** (`src/proto/client/`): Encrypted payload - `ClientMessage` (TEXT, IMAGE, FRIEND_REQUEST, FRIEND_RESPONSE)

To pull latest server proto:
```bash
git submodule update --remote proto
```

## Scripts

| Command | Description |
|---------|-------------|
| `npm run dev` | Start development server |
| `npm run build` | Build for production |
| `npm run preview` | Preview production build |
| `npm run test:e2e` | Run E2E tests (uses `VITE_API_URL` from `.env`) |
| `npm run test:browser` | Run Playwright browser tests |

## Message Architecture

- **Send:** HTTP POST to `/v1/messages/{recipientId}`
- **Receive:** WebSocket at `/v1/gateway` (server pushes queued messages on connect)

### Flow

```
┌─────────────────────────────────────────────────────┐
│              WEBSOCKET CONNECT                       │
├─────────────────────────────────────────────────────┤
│  1. Connect to /v1/gateway                          │
│  2. Server pushes queued Envelopes                  │
│  3. For each envelope:                              │
│     → decrypt (Signal protocol)                     │
│     → route to handler (friend request, content)    │
│     → persist to IndexedDB                          │
│     → ACK via AckMessage frame                      │
└─────────────────────────────────────────────────────┘
```

### Key Principles

- **Ack only after persistence**: Messages are acknowledged only after successfully persisting to local IndexedDB. If processing fails, the message stays queued on the server for retry.
- **Unified processing**: `processEnvelope()` handles all messages through one path.
- **Friend data persists**: Logging out does not clear the friend store - pending friend requests survive across sessions.

### Server API

See the Obscura Server OpenAPI spec at `{YOUR_SERVER}/openapi.yaml` for endpoint details.

## Debugging

### Server Issues

When debugging authentication, key validation, or signature errors, check the server source:

- **Server Repo:** https://github.com/barrelmaker97/obscura-server
- **Key validation:** `src/core/auth.rs` - `verify_signature()` function
- **Key upload:** `src/core/key_service.rs`

### Running Tests

```bash
# Load env vars then run
export $(cat .env | xargs) && npm run test:e2e

# Or
source .env && node test/smoke/test-keys.js
```

### Testing Against Local Server

See [obscura-server/LOCAL_DEV_MACOS.md](https://github.com/barrelmaker97/obscura-server) for server setup.

```bash
# Start local server (port 3000), then:
VITE_API_URL=http://localhost:3000 npx playwright test --headed

# Or a specific scenario:
VITE_API_URL=http://localhost:3000 npx playwright test test/browser/scenario-6.spec.js --headed
```

## Tech Stack

- [Vite](https://vitejs.dev/) - Build tool
- [Navigo](https://github.com/krasimir/navigo) - Router
- [Protobuf.js](https://protobufjs.github.io/protobuf.js/) - Protocol Buffers
- [@privacyresearch/libsignal-protocol-typescript](https://github.com/nicholassm/libsignal-protocol-typescript) - Signal Protocol
