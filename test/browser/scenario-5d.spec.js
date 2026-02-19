/**
 * E2E Scenario 5d - Multi-Device SESSION_RESET with Fan-out and Self-Sync
 *
 * Tests SESSION_RESET in a realistic multi-device environment:
 *   - Alice has 2 devices (Alice1, Alice2)
 *   - Bob has 2 devices (Bob1, Bob2)
 *   - 4 independent Signal sessions exist
 *
 * Session Matrix:
 *   Alice1 ↔ Bob1  (session A1-B1)
 *   Alice1 ↔ Bob2  (session A1-B2)
 *   Alice2 ↔ Bob1  (session A2-B1)
 *   Alice2 ↔ Bob2  (session A2-B2)
 *
 * Test Flow:
 *   1. Setup all 4 devices and establish friendshipz
 *   2. Verify fan-out works (Alice1 sends → both Bob devices receive)
 *   3. Verify self-sync works (Alice1 sends → Alice2 gets SENT_SYNC)
 *   4. Corrupt Bob2's session with Alice1
 *   5. Bob2 calls resetSessionWith(alice1DeviceId)
 *   6. Verify ALL communication paths still work after reset
 */
import { test, expect } from '@playwright/test';
import { TEST_PASSWORD } from './helpers.js';

const delay = (ms = 300) => new Promise(r => setTimeout(r, ms));

function randomUsername() {
  return 'test_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
}

test.describe('Scenario 5d: Multi-Device SESSION_RESET', () => {

  test('SESSION_RESET works with fan-out and self-sync', async ({ browser }) => {
    test.setTimeout(300000); // 5 minutes - this is a complex test

    // ============================================================
    // SETUP: Create 4 browser contexts (2 users × 2 devices each)
    // ============================================================
    const alice1Context = await browser.newContext();
    const alice2Context = await browser.newContext();
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
    // STEP 1: Register Alice (Device 1)
    // ============================================================
    console.log('\n=== STEP 1: Register Alice (Device 1) ===');
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
    console.log('Alice1 registered and connected');

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
    // STEP 3: Make Alice and Bob friends
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
    // STEP 4: Link Alice's second device
    // ============================================================
    console.log('\n=== STEP 4: Link Alice Device 2 ===');
    const alice2Page = await alice2Context.newPage();
    alice2Page.on('dialog', dialog => dialog.accept());
    alice2Page.on('console', msg => console.log('[alice2]', msg.text()));

    await alice2Page.goto('/login');
    await alice2Page.waitForSelector('#username', { timeout: 10000 });
    await alice2Page.fill('#username', aliceUsername);
    await alice2Page.fill('#password', password);
    await alice2Page.click('button[type="submit"]');
    await delay(300);

    await alice2Page.waitForURL('**/link-pending', { timeout: 15000 });
    await alice2Page.waitForSelector('.link-code', { timeout: 10000 });
    const alice2LinkCode = await alice2Page.$eval('.link-code', el => el.value || el.textContent);
    console.log('Alice2 link code captured');

    await alice1Page.evaluate(async (code) => {
      await window.__client.approveLink(code);
    }, alice2LinkCode);
    console.log('Alice1 approved Alice2');

    await alice2Page.waitForURL('**/stories', { timeout: 20000 });
    let alice2Ws = false;
    for (let i = 0; i < 10; i++) {
      await delay(500);
      alice2Ws = await alice2Page.evaluate(() => window.__client?.ws?.readyState === 1);
      if (alice2Ws) break;
    }
    expect(alice2Ws).toBe(true);
    console.log('Alice2 connected and synced');

    // ============================================================
    // STEP 5: Link Bob's second device
    // ============================================================
    console.log('\n=== STEP 5: Link Bob Device 2 ===');
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

    // Get all device IDs
    const alice1DeviceId = await alice1Page.evaluate(() => window.__client.userId);
    const alice2DeviceId = await alice2Page.evaluate(() => window.__client.userId);
    const bob1DeviceId = await bob1Page.evaluate(() => window.__client.userId);
    const bob2DeviceId = await bob2Page.evaluate(() => window.__client.userId);

    console.log('\n=== Device IDs ===');
    console.log('Alice1:', alice1DeviceId?.slice(-8));
    console.log('Alice2:', alice2DeviceId?.slice(-8));
    console.log('Bob1:', bob1DeviceId?.slice(-8));
    console.log('Bob2:', bob2DeviceId?.slice(-8));

    // ============================================================
    // STEP 6: Verify fan-out and self-sync work BEFORE reset
    // ============================================================
    console.log('\n=== STEP 6: Verify fan-out and self-sync (before reset) ===');

    // Alice1 sends message
    const bob1MsgPromise = bob1Page.waitForEvent('console', {
      predicate: msg => msg.text().includes('[Global] Message from:'),
      timeout: 15000,
    });
    const bob2MsgPromise = bob2Page.waitForEvent('console', {
      predicate: msg => msg.text().includes('[Global] Message from:'),
      timeout: 15000,
    });
    const alice2SentSyncPromise = alice2Page.waitForEvent('console', {
      predicate: msg => msg.text().includes('[Global] Sent sync:') || msg.text().includes('SENT_SYNC'),
      timeout: 15000,
    });

    await alice1Page.goto(`/messages/${bobUsername}`);
    await alice1Page.waitForSelector('#message-text');
    await alice1Page.fill('#message-text', 'Hello from Alice1 - testing fan-out!');
    await alice1Page.click('button[type="submit"]');
    await delay(300);

    await Promise.all([bob1MsgPromise, bob2MsgPromise]);
    console.log('Fan-out works: Bob1 AND Bob2 received message from Alice1');

    await alice2SentSyncPromise;
    console.log('Self-sync works: Alice2 received SENT_SYNC from Alice1');

    // ============================================================
    // STEP 7: Establish all sessions by having each device send
    // ============================================================
    console.log('\n=== STEP 7: Establish all 4 session pairs ===');

    // Bob1 sends to Alice (establishes B1→A sessions)
    const alice1FromBob1Promise = alice1Page.waitForEvent('console', {
      predicate: msg => msg.text().includes('[Global] Message from:'),
      timeout: 15000,
    });
    const alice2FromBob1Promise = alice2Page.waitForEvent('console', {
      predicate: msg => msg.text().includes('[Global] Message from:'),
      timeout: 15000,
    });

    await bob1Page.goto(`/messages/${aliceUsername}`);
    await bob1Page.waitForSelector('#message-text');
    await bob1Page.fill('#message-text', 'Hello from Bob1!');
    await bob1Page.click('button[type="submit"]');
    await delay(300);

    await Promise.all([alice1FromBob1Promise, alice2FromBob1Promise]);
    console.log('Bob1 → Alice (both devices): OK');

    // Bob2 sends to Alice (establishes B2→A sessions)
    const alice1FromBob2Promise = alice1Page.waitForEvent('console', {
      predicate: msg => msg.text().includes('[Global] Message from:'),
      timeout: 15000,
    });
    const alice2FromBob2Promise = alice2Page.waitForEvent('console', {
      predicate: msg => msg.text().includes('[Global] Message from:'),
      timeout: 15000,
    });

    await bob2Page.goto(`/messages/${aliceUsername}`);
    await bob2Page.waitForSelector('#message-text');
    await bob2Page.fill('#message-text', 'Hello from Bob2!');
    await bob2Page.click('button[type="submit"]');
    await delay(300);

    await Promise.all([alice1FromBob2Promise, alice2FromBob2Promise]);
    console.log('Bob2 → Alice (both devices): OK');

    // Alice2 sends to Bob (establishes A2→B sessions)
    const bob1FromAlice2Promise = bob1Page.waitForEvent('console', {
      predicate: msg => msg.text().includes('[Global] Message from:'),
      timeout: 15000,
    });
    const bob2FromAlice2Promise = bob2Page.waitForEvent('console', {
      predicate: msg => msg.text().includes('[Global] Message from:'),
      timeout: 15000,
    });

    await alice2Page.goto(`/messages/${bobUsername}`);
    await alice2Page.waitForSelector('#message-text');
    await alice2Page.fill('#message-text', 'Hello from Alice2!');
    await alice2Page.click('button[type="submit"]');
    await delay(300);

    await Promise.all([bob1FromAlice2Promise, bob2FromAlice2Promise]);
    console.log('Alice2 → Bob (both devices): OK');

    console.log('All 4 session pairs established');

    // ============================================================
    // STEP 8: Verify sessions exist
    // ============================================================
    console.log('\n=== STEP 8: Verify all sessions exist ===');

    const bob2HasSessionWithAlice1 = await bob2Page.evaluate(async (aliceId) => {
      const address = `${aliceId}.1`;
      const session = await window.__client.store.loadSession(address);
      return !!session;
    }, alice1DeviceId);
    expect(bob2HasSessionWithAlice1).toBe(true);
    console.log('Bob2 has session with Alice1:', bob2HasSessionWithAlice1);

    // ============================================================
    // STEP 9: Corrupt Bob2's session with Alice1
    // ============================================================
    console.log('\n=== STEP 9: Corrupt Bob2 session with Alice1 ===');

    await bob2Page.evaluate(async (aliceId) => {
      const address = `${aliceId}.1`;
      await window.__client.store.removeSession(address);
      console.log('[TEST] Deleted session:', address);
    }, alice1DeviceId);
    console.log('Bob2 session with Alice1 DELETED (simulating corruption)');

    // Verify session is gone
    const bob2SessionAfterCorrupt = await bob2Page.evaluate(async (aliceId) => {
      const address = `${aliceId}.1`;
      const session = await window.__client.store.loadSession(address);
      return !!session;
    }, alice1DeviceId);
    expect(bob2SessionAfterCorrupt).toBe(false);
    console.log('Bob2 session with Alice1 after corruption:', bob2SessionAfterCorrupt);

    // ============================================================
    // STEP 10: Bob2 resets session with Alice1
    // ============================================================
    console.log('\n=== STEP 10: Bob2 resets session with Alice1 ===');

    // Alice1 should receive SESSION_RESET
    const alice1ResetPromise = alice1Page.waitForEvent('console', {
      predicate: msg => msg.text().includes('Session reset received') || msg.text().includes('[ws] Message: SESSION_RESET'),
      timeout: 15000,
    });

    await bob2Page.evaluate(async (aliceId) => {
      console.log('[TEST] Calling resetSessionWith for Alice1:', aliceId?.slice(-8));
      await window.__client.resetSessionWith(aliceId, 'multi_device_test');
    }, alice1DeviceId);
    console.log('Bob2 sent SESSION_RESET to Alice1');

    await alice1ResetPromise;
    console.log('Alice1 received SESSION_RESET from Bob2');

    // Wait for cleanup
    await delay(500);

    // Verify Alice1's session with Bob2 is deleted
    const alice1SessionWithBob2AfterReset = await alice1Page.evaluate(async (bobId) => {
      const address = `${bobId}.1`;
      const session = await window.__client.store.loadSession(address);
      return !!session;
    }, bob2DeviceId);
    expect(alice1SessionWithBob2AfterReset).toBe(false);
    console.log('Alice1 session with Bob2 after reset:', alice1SessionWithBob2AfterReset, '(should be false)');

    // ============================================================
    // STEP 11: Verify ALL communication paths work after reset
    // ============================================================
    console.log('\n=== STEP 11: Verify all communication paths after reset ===');

    // --- Alice1 → Bob (fan-out to Bob1 AND Bob2) ---
    console.log('\n--- Test: Alice1 → Bob (fan-out) ---');
    const bob1AfterResetPromise = bob1Page.waitForEvent('console', {
      predicate: msg => msg.text().includes('[Global] Message from:'),
      timeout: 15000,
    });
    const bob2AfterResetPromise = bob2Page.waitForEvent('console', {
      predicate: msg => msg.text().includes('[Global] Message from:'),
      timeout: 15000,
    });

    await alice1Page.goto(`/messages/${bobUsername}`);
    await alice1Page.waitForSelector('#message-text');
    await alice1Page.fill('#message-text', 'Post-reset from Alice1!');
    await alice1Page.click('button[type="submit"]');
    await delay(300);

    await Promise.all([bob1AfterResetPromise, bob2AfterResetPromise]);
    console.log('Alice1 → Bob1: OK');
    console.log('Alice1 → Bob2: OK (session was reset, now works)');

    // --- Alice1 sends, Alice2 gets SENT_SYNC ---
    console.log('\n--- Test: Alice1 → Alice2 (self-sync) ---');
    const alice2SentSync2Promise = alice2Page.waitForEvent('console', {
      predicate: msg => msg.text().includes('[Global] Sent sync:') || msg.text().includes('SENT_SYNC'),
      timeout: 15000,
    });

    await alice1Page.fill('#message-text', 'Another message for self-sync test');
    await alice1Page.click('button[type="submit"]');
    await delay(300);

    await alice2SentSync2Promise;
    console.log('Alice1 → Alice2 (SENT_SYNC): OK');

    // --- Bob2 → Alice (should work with new session) ---
    console.log('\n--- Test: Bob2 → Alice (both devices) ---');
    const alice1FromBob2AfterPromise = alice1Page.waitForEvent('console', {
      predicate: msg => msg.text().includes('[Global] Message from:'),
      timeout: 15000,
    });
    const alice2FromBob2AfterPromise = alice2Page.waitForEvent('console', {
      predicate: msg => msg.text().includes('[Global] Message from:'),
      timeout: 15000,
    });

    await bob2Page.goto(`/messages/${aliceUsername}`);
    await bob2Page.waitForSelector('#message-text');
    await bob2Page.fill('#message-text', 'Post-reset from Bob2!');
    await bob2Page.click('button[type="submit"]');
    await delay(300);

    await Promise.all([alice1FromBob2AfterPromise, alice2FromBob2AfterPromise]);
    console.log('Bob2 → Alice1: OK (bidirectional after reset)');
    console.log('Bob2 → Alice2: OK (unaffected session)');

    // --- Bob1 → Alice (should still work, unaffected) ---
    console.log('\n--- Test: Bob1 → Alice (unaffected) ---');
    const alice1FromBob1AfterPromise = alice1Page.waitForEvent('console', {
      predicate: msg => msg.text().includes('[Global] Message from:'),
      timeout: 15000,
    });
    const alice2FromBob1AfterPromise = alice2Page.waitForEvent('console', {
      predicate: msg => msg.text().includes('[Global] Message from:'),
      timeout: 15000,
    });

    await bob1Page.goto(`/messages/${aliceUsername}`);
    await bob1Page.waitForSelector('#message-text');
    await bob1Page.fill('#message-text', 'Bob1 still works!');
    await bob1Page.click('button[type="submit"]');
    await delay(300);

    await Promise.all([alice1FromBob1AfterPromise, alice2FromBob1AfterPromise]);
    console.log('Bob1 → Alice1: OK (unaffected)');
    console.log('Bob1 → Alice2: OK (unaffected)');

    // --- Alice2 → Bob (should still work, unaffected) ---
    console.log('\n--- Test: Alice2 → Bob (unaffected) ---');
    const bob1FromAlice2AfterPromise = bob1Page.waitForEvent('console', {
      predicate: msg => msg.text().includes('[Global] Message from:'),
      timeout: 15000,
    });
    const bob2FromAlice2AfterPromise = bob2Page.waitForEvent('console', {
      predicate: msg => msg.text().includes('[Global] Message from:'),
      timeout: 15000,
    });

    await alice2Page.goto(`/messages/${bobUsername}`);
    await alice2Page.waitForSelector('#message-text');
    await alice2Page.fill('#message-text', 'Alice2 still works!');
    await alice2Page.click('button[type="submit"]');
    await delay(300);

    await Promise.all([bob1FromAlice2AfterPromise, bob2FromAlice2AfterPromise]);
    console.log('Alice2 → Bob1: OK (unaffected)');
    console.log('Alice2 → Bob2: OK (unaffected)');

    // ============================================================
    // STEP 12: Verify message content
    // ============================================================
    console.log('\n=== STEP 12: Verify message content ===');

    await bob2Page.goto(`/messages/${aliceUsername}`);
    await bob2Page.waitForSelector('.message', { timeout: 10000 });
    const bob2Messages = await bob2Page.$$eval('.message .text', els => els.map(e => e.textContent));
    expect(bob2Messages).toContain('Post-reset from Alice1!');
    console.log('Bob2 has post-reset message from Alice1');

    await alice1Page.waitForSelector('.message', { timeout: 10000 });
    const alice1Messages = await alice1Page.$$eval('.message .text', els => els.map(e => e.textContent));
    expect(alice1Messages).toContain('Post-reset from Bob2!');
    console.log('Alice1 has post-reset message from Bob2');

    console.log('\n=== SCENARIO 5d COMPLETE ===');
    console.log('Multi-device SESSION_RESET with fan-out and self-sync: SUCCESS');
    console.log('Session Matrix after test:');
    console.log('  Alice1 ↔ Bob1: OK (unaffected)');
    console.log('  Alice1 ↔ Bob2: OK (RESET and recovered)');
    console.log('  Alice2 ↔ Bob1: OK (unaffected)');
    console.log('  Alice2 ↔ Bob2: OK (unaffected)');

    // ============================================================
    // CLEANUP
    // ============================================================
    await bob2Context.close();
    await bob1Context.close();
    await alice2Context.close();
    await alice1Context.close();
  });

});
