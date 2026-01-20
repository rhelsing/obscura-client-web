// E2E Test: Friend Request Flow
// Tests against real server: https://obscura.barrelmaker.dev

import { TestClient, randomUsername } from '../helpers/testClient.js';
import WebSocket from 'ws';

const API_URL = 'https://obscura.barrelmaker.dev';

describe('Friend Request E2E', () => {
  let userA, userB;

  beforeAll(async () => {
    // Create test clients
    userA = new TestClient(API_URL);
    userB = new TestClient(API_URL);
  });

  afterAll(async () => {
    // Cleanup
    if (userA?.ws) userA.disconnectWebSocket();
    if (userB?.ws) userB.disconnectWebSocket();
  });

  describe('1. Registration', () => {
    test('User A registers successfully', async () => {
      const username = randomUsername();
      await userA.register(username);

      expect(userA.token).toBeDefined();
      expect(userA.userId).toBeDefined();
      expect(userA.username).toBe(username);

      // Verify keys were generated
      const hasKeys = await userA.store.hasIdentity();
      expect(hasKeys).toBe(true);
    });

    test('User B registers successfully', async () => {
      const username = randomUsername();
      await userB.register(username);

      expect(userB.token).toBeDefined();
      expect(userB.userId).toBeDefined();
    });
  });

  describe('2. Key Persistence (Logout/Login)', () => {
    let userAIdentityBefore;

    test('Capture User A identity key before logout', async () => {
      const keyPair = await userA.store.getIdentityKeyPair();
      userAIdentityBefore = new Uint8Array(keyPair.pubKey);
      expect(userAIdentityBefore.length).toBeGreaterThan(0);
    });

    test('User A logs out', async () => {
      await userA.logout();
      expect(userA.token).toBeNull();
    });

    test('User A logs back in', async () => {
      await userA.login();
      expect(userA.token).toBeDefined();
    });

    test('User A identity key unchanged after login', async () => {
      const keyPair = await userA.store.getIdentityKeyPair();
      const keyAfter = new Uint8Array(keyPair.pubKey);

      // Keys should be identical
      expect(keyAfter.length).toBe(userAIdentityBefore.length);
      for (let i = 0; i < keyAfter.length; i++) {
        expect(keyAfter[i]).toBe(userAIdentityBefore[i]);
      }
    });
  });

  describe('3. Live Friend Request (WebSocket)', () => {
    test('User A connects to WebSocket', async () => {
      await userA.connectWebSocket();
      expect(userA.ws.readyState).toBe(WebSocket.OPEN);
    });

    test('User B connects to WebSocket', async () => {
      await userB.connectWebSocket();
      expect(userB.ws.readyState).toBe(WebSocket.OPEN);
    });

    test('User A sends friend request to User B', async () => {
      await userA.sendFriendRequest(userB.userId);
    });

    test('User B receives friend request in real-time', async () => {
      const msg = await userB.waitForMessage(10000);

      expect(msg).toBeDefined();
      expect(msg.type).toBe('FRIEND_REQUEST');
      expect(msg.username).toBe(userA.username);
      expect(msg.sourceUserId).toBe(userA.userId);
    });
  });

  describe('4. Async Friend Request (Queued)', () => {
    test('User B disconnects WebSocket', async () => {
      userB.disconnectWebSocket();
      expect(userB.ws).toBeNull();
    });

    test('User A sends message while User B offline', async () => {
      // Send a text message (User B is offline)
      await userA.sendMessage(userB.userId, {
        type: 'TEXT',
        text: 'hello from offline test',
      });
    });

    test('User B reconnects and receives queued message', async () => {
      // Reconnect
      await userB.connectWebSocket();
      expect(userB.ws.readyState).toBe(WebSocket.OPEN);

      // Should receive the queued message
      const msg = await userB.waitForMessage(10000);

      expect(msg).toBeDefined();
      expect(msg.type).toBe('TEXT');
      expect(msg.text).toBe('hello from offline test');
    });
  });

  describe('5. Bidirectional Communication', () => {
    test('User B sends friend response to User A', async () => {
      await userB.sendMessage(userA.userId, {
        type: 'FRIEND_RESPONSE',
        username: userB.username,
        accepted: true,
      });
    });

    test('User A receives friend response', async () => {
      const msg = await userA.waitForMessage(10000);

      expect(msg).toBeDefined();
      expect(msg.type).toBe('FRIEND_RESPONSE');
      expect(msg.accepted).toBe(true);
      expect(msg.username).toBe(userB.username);
    });
  });
});
