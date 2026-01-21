// E2E Test: PreKey Replenishment
// Tests prekey generation and upload against real server

import { TestClient, randomUsername } from '../helpers/testClient.js';

const API_URL = 'https://obscura.barrelmaker.dev';

describe('PreKey Replenishment E2E', () => {
  let user;

  beforeAll(async () => {
    user = new TestClient(API_URL);
  });

  describe('1. Initial Registration', () => {
    test('User registers with 100 prekeys', async () => {
      const username = randomUsername();
      await user.register(username);

      expect(user.token).toBeDefined();
      expect(user.userId).toBeDefined();

      // Verify 100 prekeys were generated
      const count = user.store.getPreKeyCount();
      expect(count).toBe(100);

      const highestId = user.store.getHighestPreKeyId();
      expect(highestId).toBe(100);
    });
  });

  describe('2. Simulate Depletion', () => {
    test('Delete prekeys to simulate consumption', () => {
      // Keep only 10 prekeys (below typical threshold of 20)
      const remaining = user.store.deletePreKeysExcept(10);
      expect(remaining).toBe(10);

      const count = user.store.getPreKeyCount();
      expect(count).toBe(10);
    });
  });

  describe('3. Replenish PreKeys', () => {
    let newPreKeys;
    let newSignedPreKey;

    test('Generate 50 new prekeys', async () => {
      const highestId = user.store.getHighestPreKeyId();
      const startId = highestId + 1;

      newPreKeys = await user.generateMorePreKeys(startId, 50);

      expect(newPreKeys).toHaveLength(50);
      expect(newPreKeys[0].keyId).toBe(startId);
      expect(newPreKeys[49].keyId).toBe(startId + 49);

      // Each prekey should have keyId and base64 publicKey
      for (const pk of newPreKeys) {
        expect(pk.keyId).toBeDefined();
        expect(pk.publicKey).toBeDefined();
        expect(typeof pk.publicKey).toBe('string');
      }
    });

    test('Generate new signed prekey', async () => {
      newSignedPreKey = await user.generateNewSignedPreKey();

      expect(newSignedPreKey.keyId).toBeDefined();
      expect(newSignedPreKey.publicKey).toBeDefined();
      expect(newSignedPreKey.signature).toBeDefined();

      // Should be keyId 2 (after initial keyId 1)
      expect(newSignedPreKey.keyId).toBe(2);
    });

    test('Upload new keys to server', async () => {
      // This is the actual server interaction - verifies API format is correct
      await expect(
        user.uploadKeys({
          signedPreKey: newSignedPreKey,
          oneTimePreKeys: newPreKeys,
        })
      ).resolves.not.toThrow();

      console.log('Successfully uploaded 50 prekeys to server');
    });

    test('Local prekey count is now 60', () => {
      const count = user.store.getPreKeyCount();
      expect(count).toBe(60); // 10 remaining + 50 new
    });
  });
});
