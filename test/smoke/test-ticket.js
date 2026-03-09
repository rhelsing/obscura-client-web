// Smoke test: Verify gateway ticket endpoint works
// Run with: node test/smoke/test-ticket.js
import '../helpers/setup.js';
import { TestClient, randomUsername } from '../helpers/testClient.js';

const API_URL = process.env.VITE_API_URL || process.env.OBSCURA_API_URL || 'https://obscura.barrelmaker.dev';
console.log('Testing gateway ticket against:', API_URL);

const client = new TestClient(API_URL);

try {
  // Step 1: Register
  console.log('\n--- Step 1: Register ---');
  await client.register(randomUsername());
  console.log('OK - Registered, userId:', client.userId);

  // Step 2: Get gateway ticket
  console.log('\n--- Step 2: Get gateway ticket ---');
  const result = await client.request('/v1/gateway/ticket', { method: 'POST' });
  console.log('OK - Got ticket:', result.ticket);

  // Step 3: Connect WebSocket with ticket
  console.log('\n--- Step 3: Connect WebSocket with ticket ---');
  await client.connectWebSocket();
  console.log('OK - WebSocket connected!');

  // Step 4: Wait a moment, then disconnect
  await new Promise(r => setTimeout(r, 1000));
  client.disconnectWebSocket();
  console.log('OK - WebSocket disconnected cleanly');

  console.log('\n=== ALL TESTS PASSED ===');
  process.exit(0);
} catch (err) {
  console.error('\nFAILED:', err.message);
  process.exit(1);
}
