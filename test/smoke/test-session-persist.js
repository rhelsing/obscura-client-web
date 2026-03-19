#!/usr/bin/env node
/**
 * Test: Does the Signal session persist in IndexedDB across store instances?
 */
import '../../test/helpers/setup.js';
import { createStore } from '../../src/v2/lib/store.js';

const namespace = `persist_test_${Date.now()}`;

// Create store, save a session
const store1 = createStore(namespace);
const testAddr = 'test-user-id.12345';
const testRecord = { someData: 'session-data-' + Date.now() };

await store1.storeSession(testAddr, testRecord);
console.log('Stored session at:', testAddr);

// Verify it's there
const loaded1 = await store1.loadSession(testAddr);
console.log('Loaded from same instance:', !!loaded1);

// Create a NEW store instance with same namespace (simulates page reload)
const store2 = createStore(namespace);
const loaded2 = await store2.loadSession(testAddr);
console.log('Loaded from new instance:', !!loaded2);
console.log('Data matches:', JSON.stringify(loaded1) === JSON.stringify(loaded2));

if (loaded2) {
  console.log('SESSION PERSISTENCE: PASSED');
} else {
  console.log('SESSION PERSISTENCE: FAILED');
  process.exit(1);
}
