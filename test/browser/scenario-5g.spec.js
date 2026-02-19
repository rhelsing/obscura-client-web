/**
 * E2E Scenario 5g - Multi-Device Auto-Recovery with Fan-Out
 *
 * Tests automatic SESSION_RESET in a multi-device environment:
 *   - Alice has 1 device (Alice1)
 *   - Bob has 2 devices (Bob1, Bob2)
 *   - Bob1 loses session with Alice1
 *   - Alice1 sends message (fans out to Bob1 AND Bob2)
 *   - Bob1 auto-recovers, Bob2 receives normally
 *   - Verifies per-device recovery doesn't affect other devices
 *
 * Session Matrix:
 *   Alice1 ↔ Bob1  (will be deleted, then auto-recovered)
 *   Alice1 ↔ Bob2  (unaffected)
 *
 * Key Assertions:
 *   - Auto-recovery is per-device
 *   - Bob2's session is unaffected by Bob1's reset
 *   - Fan-out continues to work after partial recovery
 */
import { test, expect } from '@playwright/test';
import { TEST_PASSWORD } from './helpers.js';

const delay = (ms = 300) => new Promise(r => setTimeout(r, ms));

function randomUsername() {
  return 'test_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
}

test.describe('Scenario 5g: Multi-Device Auto-Recovery', () => {

  test('Auto-recovery works correctly with fan-out', async ({ browser }) => {
    test.setTimeout(300000); // 5 minutes

    // ============================================================
    // SETUP: Create browser contexts (Alice1, Bob1, Bob2)
    // ============================================================
    const alice1Context = await browser.newContext();
    const bob1Context = await browser.newContext();
    const bob2Context = await browser.newContext();

    const alice1Page = await alice1Context.newPage();
    const bob1Page = await bob1Context.newPage();

    alice1Page.on('dialog', dialog => dialog.accept());
    bob1Page.on('dialog', dialog => dialog.accept());
    alice1Page.on('console', msg => console.log('[alice1]', msg.text()));
    bob1Page.on('console', msg => console.log('[bob1]', msg.text()));

    const aliceUsername = randomUsername();
    const bobUsername = randomUsername();
    const password = TEST_PASSWORD;

    // ============================================================
    // STEP 1: Register Alice
    // ============================================================
    console.log('\n=== STEP 1: Register Alice ===');
    await alice1Page.goto('/register');
    await alice1Page.waitForSelector('#username', { timeout: 30000 });
    await alice1Page.fill('#username', aliceUsername);
    await alice1Page.fill('#password', password);
    await alice1Page.fill('#confirm-password', password);
    await alice1Page.click('button[type="submit"]');
    await delay(300);

    await alice1Page.waitForSelector('.phrase-box', { timeout: 30000 });
    await alice1Page.check('#confirm-saved');
    await alice1Page.click('#continue-btn');
    await delay(300);
    await alice1Page.waitForURL('**/stories', { timeout: 30000 });

    let alice1Ws = false;
    for (let i = 0; i < 10; i++) {
      await delay(500);
      alice1Ws = await alice1Page.evaluate(() => window.__client?.ws?.readyState === 1);
      if (alice1Ws) break;
    }
    expect(alice1Ws).toBe(true);
    console.log('Alice registered and connected');

    // ============================================================
    // STEP 2: Register Bob (Device 1)
    // ============================================================
    console.log('\n=== STEP 2: Register Bob (Device 1) ===');
    await bob1Page.goto('/register');
    await bob1Page.waitForSelector('#username', { timeout: 30000 });
    await bob1Page.fill('#username', bobUsername);
    await bob1Page.fill('#password', password);
    await bob1Page.fill('#confirm-password', password);
    await bob1Page.click('button[type="submit"]');
    await delay(300);

    await bob1Page.waitForSelector('.phrase-box', { timeout: 30000 });
    await bob1Page.check('#confirm-saved');
    await bob1Page.click('#continue-btn');
    await delay(300);
    await bob1Page.waitForURL('**/stories', { timeout: 30000 });

    let bob1Ws = false;
    for (let i = 0; i < 10; i++) {
      await delay(500);
      bob1Ws = await bob1Page.evaluate(() => window.__client?.ws?.readyState === 1);
      if (bob1Ws) break;
    }
    expect(bob1Ws).toBe(true);
    console.log('Bob1 registered and connected');

    // ============================================================
    // STEP 3: Make friends
    // ============================================================
    console.log('\n=== STEP 3: Make friends ===');
    await bob1Page.goto('/friends/add');
    await bob1Page.waitForSelector('#my-link-input');
    const bobLink = await bob1Page.inputValue('#my-link-input');

    const bobRequestPromise = bob1Page.waitForEvent('console', {
      predicate: msg => msg.text().includes('Friend request from:'),
      timeout: 30000,
    });

    await alice1Page.goto('/friends/add');
    await alice1Page.waitForSelector('#friend-link');
    await alice1Page.fill('#friend-link', bobLink);
    await alice1Page.click('button[type="submit"]');
    await delay(300);
    await alice1Page.waitForSelector('#done-btn', { timeout: 15000 });

    await bobRequestPromise;
    await delay(500);

    await bob1Page.goto('/friends');
    await bob1Page.waitForSelector('.friend-item.pending', { timeout: 15000 });

    const aliceResponsePromise = alice1Page.waitForEvent('console', {
      predicate: msg => msg.text().includes('Friend response:'),
      timeout: 30000,
    });
    await bob1Page.click(`.accept-btn[data-username="${aliceUsername}"]`);
    await delay(500);
    await aliceResponsePromise;
    console.log('Alice and Bob are friends');

    // ============================================================
    // STEP 4: Link Bob's second device
    // ============================================================
    console.log('\n=== STEP 4: Link Bob Device 2 ===');
    const bob2Page = await bob2Context.newPage();
    bob2Page.on('dialog', dialog => dialog.accept());
    bob2Page.on('console', msg => console.log('[bob2]', msg.text()));

    await bob2Page.goto('/login');
    await bob2Page.waitForSelector('#username', { timeout: 10000 });
    await bob2Page.fill('#username', bobUsername);
    await bob2Page.fill('#password', password);
    await bob2Page.click('button[type="submit"]');
    await delay(300);

    await bob2Page.waitForURL('**/link-pending', { timeout: 15000 });
    await bob2Page.waitForSelector('.link-code', { timeout: 10000 });
    const bob2LinkCode = await bob2Page.$eval('.link-code', el => el.value || el.textContent);
    console.log('Bob2 link code captured');

    await bob1Page.evaluate(async (code) => {
      await window.__client.approveLink(code);
    }, bob2LinkCode);
    console.log('Bob1 approved Bob2');

    await bob2Page.waitForURL('**/stories', { timeout: 20000 });
    let bob2Ws = false;
    for (let i = 0; i < 10; i++) {
      await delay(500);
      bob2Ws = await bob2Page.evaluate(() => window.__client?.ws?.readyState === 1);
      if (bob2Ws) break;
    }
    expect(bob2Ws).toBe(true);
    console.log('Bob2 connected and synced');

    // Get device IDs
    const alice1DeviceId = await alice1Page.evaluate(() => window.__client.userId);
    const bob1DeviceId = await bob1Page.evaluate(() => window.__client.userId);
    const bob2DeviceId = await bob2Page.evaluate(() => window.__client.userId);

    console.log('\n=== Device IDs ===');
    console.log('Alice1:', alice1DeviceId?.slice(-8));
    console.log('Bob1:', bob1DeviceId?.slice(-8));
    console.log('Bob2:', bob2DeviceId?.slice(-8));

    // ============================================================
    // STEP 5: Establish all sessions
    // ============================================================
    console.log('\n=== STEP 5: Establish sessions ===');

    // Alice1 sends to Bob (establishes Alice1 → Bob1, Bob2)
    const bob1MsgPromise = bob1Page.waitForEvent('console', {
      predicate: msg => msg.text().includes('[Global] Message from:'),
      timeout: 15000,
    });
    const bob2MsgPromise = bob2Page.waitForEvent('console', {
      predicate: msg => msg.text().includes('[Global] Message from:'),
      timeout: 15000,
    });

    await alice1Page.goto(`/messages/${bobUsername}`);
    await alice1Page.waitForSelector('#message-text');
    await alice1Page.fill('#message-text', 'Hello Bob devices!');
    await alice1Page.click('button[type="submit"]');
    await delay(300);

    await Promise.all([bob1MsgPromise, bob2MsgPromise]);
    console.log('Alice1 → Bob1: OK');
    console.log('Alice1 → Bob2: OK');

    // Bob1 sends to Alice (establishes Bob1 → Alice1)
    const alice1FromBob1Promise = alice1Page.waitForEvent('console', {
      predicate: msg => msg.text().includes('[Global] Message from:'),
      timeout: 15000,
    });

    await bob1Page.goto(`/messages/${aliceUsername}`);
    await bob1Page.waitForSelector('#message-text');
    await bob1Page.fill('#message-text', 'Hello from Bob1!');
    await bob1Page.click('button[type="submit"]');
    await delay(300);

    await alice1FromBob1Promise;
    console.log('Bob1 → Alice1: OK');

    // Bob2 sends to Alice (establishes Bob2 → Alice1)
    const alice1FromBob2Promise = alice1Page.waitForEvent('console', {
      predicate: msg => msg.text().includes('[Global] Message from:'),
      timeout: 15000,
    });

    await bob2Page.goto(`/messages/${aliceUsername}`);
    await bob2Page.waitForSelector('#message-text');
    await bob2Page.fill('#message-text', 'Hello from Bob2!');
    await bob2Page.click('button[type="submit"]');
    await delay(300);

    await alice1FromBob2Promise;
    console.log('Bob2 → Alice1: OK');

    console.log('All sessions established');

    // ============================================================
    // STEP 6: Verify sessions exist
    // ============================================================
    console.log('\n=== STEP 6: Verify sessions ===');

    const bob1HasSession = await bob1Page.evaluate(async (aliceId) => {
      const address = `${aliceId}.1`;
      const session = await window.__client.store.loadSession(address);
      return !!session;
    }, alice1DeviceId);
    expect(bob1HasSession).toBe(true);
    console.log('Bob1 has session with Alice1:', bob1HasSession);

    const bob2HasSession = await bob2Page.evaluate(async (aliceId) => {
      const address = `${aliceId}.1`;
      const session = await window.__client.store.loadSession(address);
      return !!session;
    }, alice1DeviceId);
    expect(bob2HasSession).toBe(true);
    console.log('Bob2 has session with Alice1:', bob2HasSession);

    // ============================================================
    // STEP 7: Delete Bob1's session with Alice1
    // ============================================================
    console.log('\n=== STEP 7: Delete Bob1\'s session with Alice1 ===');

    await bob1Page.evaluate(async (aliceId) => {
      const address = `${aliceId}.1`;
      await window.__client.store.removeSession(address);
      console.log('[TEST] Deleted session:', address);
    }, alice1DeviceId);
    console.log('Bob1\'s session with Alice1 DELETED');

    const bob1SessionGone = await bob1Page.evaluate(async (aliceId) => {
      const address = `${aliceId}.1`;
      const session = await window.__client.store.loadSession(address);
      return !session;
    }, alice1DeviceId);
    expect(bob1SessionGone).toBe(true);
    console.log('Confirmed: Bob1 has no session with Alice1');

    // Verify Bob2's session is still intact
    const bob2StillHasSession = await bob2Page.evaluate(async (aliceId) => {
      const address = `${aliceId}.1`;
      const session = await window.__client.store.loadSession(address);
      return !!session;
    }, alice1DeviceId);
    expect(bob2StillHasSession).toBe(true);
    console.log('Bob2 still has session with Alice1:', bob2StillHasSession);

    // ============================================================
    // STEP 8: Alice1 sends message - triggers auto-recovery on Bob1
    // ============================================================
    console.log('\n=== STEP 8: Alice1 sends message (triggers auto-recovery) ===');

    // Listen for Bob1's auto-recovery
    const bob1AutoRecoveryPromise = bob1Page.waitForEvent('console', {
      predicate: msg => msg.text().includes('Auto-recovering'),
      timeout: 15000,
    });

    // Listen for Bob2 receiving message normally
    const bob2NormalReceivePromise = bob2Page.waitForEvent('console', {
      predicate: msg => msg.text().includes('[Global] Message from:'),
      timeout: 15000,
    });

    // Listen for Alice1 receiving SESSION_RESET from Bob1
    const alice1ResetPromise = alice1Page.waitForEvent('console', {
      predicate: msg => msg.text().includes('Session reset received') || msg.text().includes('[ws] Message: SESSION_RESET'),
      timeout: 15000,
    });

    // Alice1 sends (will fan out to Bob1 AND Bob2)
    await alice1Page.fill('#message-text', 'This triggers auto-recovery on Bob1!');
    await alice1Page.click('button[type="submit"]');
    console.log('Alice1 sent message (fans out to Bob1 and Bob2)');

    // Wait for results
    await bob1AutoRecoveryPromise;
    console.log('Bob1 auto-recovered (sent SESSION_RESET to Alice1)');

    await bob2NormalReceivePromise;
    console.log('Bob2 received message normally (session intact)');

    await alice1ResetPromise;
    console.log('Alice1 received SESSION_RESET from Bob1');

    await delay(500);

    // ============================================================
    // STEP 9: Verify session states after auto-recovery
    // ============================================================
    console.log('\n=== STEP 9: Verify session states ===');

    // Alice1's session with Bob1 should be cleared (from SESSION_RESET)
    const alice1SessionWithBob1 = await alice1Page.evaluate(async (bobId) => {
      const address = `${bobId}.1`;
      const session = await window.__client.store.loadSession(address);
      return !!session;
    }, bob1DeviceId);
    console.log('Alice1 session with Bob1 after reset:', alice1SessionWithBob1, '(should be false)');
    expect(alice1SessionWithBob1).toBe(false);

    // Alice1's session with Bob2 should still exist
    const alice1SessionWithBob2 = await alice1Page.evaluate(async (bobId) => {
      const address = `${bobId}.1`;
      const session = await window.__client.store.loadSession(address);
      return !!session;
    }, bob2DeviceId);
    console.log('Alice1 session with Bob2:', alice1SessionWithBob2, '(should be true - unaffected)');
    expect(alice1SessionWithBob2).toBe(true);

    // ============================================================
    // STEP 10: Alice1 sends NEW message - uses PreKey to Bob1, Whisper to Bob2
    // ============================================================
    console.log('\n=== STEP 10: Alice1 sends NEW message ===');

    const bob1NewMsgPromise = bob1Page.waitForEvent('console', {
      predicate: msg => msg.text().includes('[Global] Message from:'),
      timeout: 15000,
    });
    const bob2NewMsgPromise = bob2Page.waitForEvent('console', {
      predicate: msg => msg.text().includes('[Global] Message from:'),
      timeout: 15000,
    });

    await alice1Page.fill('#message-text', 'New message after recovery!');
    await alice1Page.click('button[type="submit"]');
    console.log('Alice1 sent new message');

    await Promise.all([bob1NewMsgPromise, bob2NewMsgPromise]);
    console.log('Bob1 received NEW message (via PreKey - new session)');
    console.log('Bob2 received NEW message (via Whisper - existing session)');

    // ============================================================
    // STEP 11: Verify message content
    // ============================================================
    console.log('\n=== STEP 11: Verify messages ===');

    await bob1Page.goto(`/messages/${aliceUsername}`);
    await bob1Page.waitForSelector('.message', { timeout: 10000 });
    const bob1Messages = await bob1Page.$$eval('.message .text', els => els.map(e => e.textContent));
    console.log('Bob1 messages:', bob1Messages);

    // Bob1 should NOT have the lost message (auto-recovery ACKed it)
    expect(bob1Messages).not.toContain('This triggers auto-recovery on Bob1!');
    // Bob1 SHOULD have the new message
    expect(bob1Messages).toContain('New message after recovery!');
    console.log('Bob1: Lost message not present, new message received');

    await bob2Page.goto(`/messages/${aliceUsername}`);
    await bob2Page.waitForSelector('.message', { timeout: 10000 });
    const bob2Messages = await bob2Page.$$eval('.message .text', els => els.map(e => e.textContent));
    console.log('Bob2 messages:', bob2Messages);

    // Bob2 SHOULD have both messages (session was never broken)
    expect(bob2Messages).toContain('This triggers auto-recovery on Bob1!');
    expect(bob2Messages).toContain('New message after recovery!');
    console.log('Bob2: Both messages received (session unaffected)');

    // ============================================================
    // STEP 12: Verify bidirectional communication works
    // ============================================================
    console.log('\n=== STEP 12: Verify bidirectional after recovery ===');

    // Bob1 sends to Alice1
    const alice1FromBob1AfterPromise = alice1Page.waitForEvent('console', {
      predicate: msg => msg.text().includes('[Global] Message from:'),
      timeout: 15000,
    });

    await bob1Page.fill('#message-text', 'Bob1 can send after recovery!');
    await bob1Page.click('button[type="submit"]');
    await delay(300);

    await alice1FromBob1AfterPromise;
    console.log('Bob1 → Alice1: OK (new session works)');

    console.log('\n=== SCENARIO 5g COMPLETE ===');
    console.log('Multi-Device Auto-Recovery with Fan-Out: SUCCESS');
    console.log('Session Matrix:');
    console.log('  Alice1 ↔ Bob1: RECOVERED (auto-reset, new session)');
    console.log('  Alice1 ↔ Bob2: INTACT (unaffected by Bob1 reset)');

    // ============================================================
    // CLEANUP
    // ============================================================
    await bob2Context.close();
    await bob1Context.close();
    await alice1Context.close();
  });

});
