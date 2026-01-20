# Obscura Web Client

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

## Updating Proto Definitions

To pull the latest proto definitions:

```bash
git submodule update --remote proto
```

## Scripts

| Command | Description |
|---------|-------------|
| `npm run dev` | Start development server |
| `npm run build` | Build for production |
| `npm run preview` | Preview production build |

## Message Architecture

The client uses a unified message processing flow that handles both queued messages (offline delivery) and real-time messages (WebSocket) through the same pipeline.

### Flow

```
┌─────────────────────────────────────────────────────┐
│                    ON CONNECT                        │
├─────────────────────────────────────────────────────┤
│  1. GET /v1/messages  (fetch anything queued)       │
│  2. For each message:                               │
│     → decrypt (Signal protocol)                     │
│     → route to handler (friend request, content)    │
│     → persist to IndexedDB                          │
│     → ACK via DELETE /v1/messages/{id}/ack          │
│  3. Connect WebSocket for real-time                 │
└─────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────┐
│               WEBSOCKET MESSAGE ARRIVES             │
├─────────────────────────────────────────────────────┤
│  1. Receive Envelope via WebSocketFrame             │
│  2. Same handler: decrypt → route → persist         │
│  3. ACK via AckMessage frame                        │
└─────────────────────────────────────────────────────┘
```

### Key Principles

- **Ack only after persistence**: Messages are acknowledged only after successfully persisting to local IndexedDB. If processing fails, the message stays queued on the server for retry.
- **Unified processing**: `processEnvelope()` handles all messages identically regardless of source (REST or WebSocket).
- **Friend data persists**: Logging out does not clear the friend store - pending friend requests survive across sessions.

### Server API

See the [Obscura Server OpenAPI spec](https://obscura.barrelmaker.dev/openapi.yaml) for endpoint details.

## Tech Stack

- [Vite](https://vitejs.dev/) - Build tool
- [Navigo](https://github.com/krasimir/navigo) - Router
- [Protobuf.js](https://protobufjs.github.io/protobuf.js/) - Protocol Buffers
