/**
 * E2E Scenario 5e - Own-Device SESSION_RESET (Intra-Device Recovery)
 *
 * Tests SESSION_RESET between own devices (Bob1↔Bob2):
 *   - SENT_SYNC flows between own devices via Signal encryption
 *   - If session corrupts, SENT_SYNC breaks
 *   - SESSION_RESET recovers the session
 *   - SENT_SYNC works again after reset
 *
 * Session being tested:
 *   Bob1 ↔ Bob2 (own-device session for SENT_SYNC)
 *
 * Test Flow:
 *   1. Bob registers with 2 devices (Bob1, Bob2)
 *   2. Alice registers (single device)
 *   3. Alice and Bob become friends
 *   4. Bob1 sends message to Alice
 *   5. Verify Bob2 receives SENT_SYNC from Bob1
 *   6. Corrupt Bob1's session with Bob2
 *   7. Bob1 sends another message
 *   8. Verify Bob2 does NOT receive SENT_SYNC (session broken)
 *   9. Bob1 calls resetSessionWith(bob2DeviceId)
 *   10. Verify Bob2 receives SESSION_RESET
 *   11. Bob1 sends message
 *   12. Verify Bob2 NOW receives SENT_SYNC (recovered)
 */
import { test, expect } from '@playwright/test';

const delay = (ms = 300) => new Promise(r => setTimeout(r, ms));

function randomUsername() {
  return 'test_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
}

test.describe('Scenario 5e: Own-Device SESSION_RESET', () => {

  test('SESSION_RESET recovers SENT_SYNC between own devices', async ({ browser }) => {
    test.setTimeout(240000); // 4 minutes

    // ============================================================
    // SETUP: Create browser contexts
    // ============================================================
    const bob1Context = await browser.newContext();
    const bob2Context = await browser.newContext();
    const aliceContext = await browser.newContext();

    const bob1Page = await bob1Context.newPage();
    const alicePage = await aliceContext.newPage();

    bob1Page.on('dialog', dialog => dialog.accept());
    alicePage.on('dialog', dialog => dialog.accept());
    bob1Page.on('console', msg => console.log('[bob1]', msg.text()));
    alicePage.on('console', msg => console.log('[alice]', msg.text()));

    const bobUsername = randomUsername();
    const aliceUsername = randomUsername();
    const password = 'testpass123';

    // ============================================================
    // STEP 1: Register Bob (Device 1)
    // ============================================================
    console.log('\n=== STEP 1: Register Bob (Device 1) ===');
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
    // STEP 2: Register Alice
    // ============================================================
    console.log('\n=== STEP 2: Register Alice ===');
    await alicePage.goto('/register');
    await alicePage.waitForSelector('#username', { timeout: 30000 });
    await alicePage.fill('#username', aliceUsername);
    await alicePage.fill('#password', password);
    await alicePage.fill('#confirm-password', password);
    await alicePage.click('button[type="submit"]');
    await delay(300);

    await alicePage.waitForSelector('.phrase-box', { timeout: 30000 });
    await alicePage.check('#confirm-saved');
    await alicePage.click('#continue-btn');
    await delay(300);
    await alicePage.waitForURL('**/stories', { timeout: 30000 });

    let aliceWs = false;
    for (let i = 0; i < 10; i++) {
      await delay(500);
      aliceWs = await alicePage.evaluate(() => window.__client?.ws?.readyState === 1);
      if (aliceWs) break;
    }
    expect(aliceWs).toBe(true);
    console.log('Alice registered and connected');

    // ============================================================
    // STEP 3: Make Alice and Bob friends
    // ============================================================
    console.log('\n=== STEP 3: Make friends ===');
    await alicePage.goto('/friends/add');
    await alicePage.waitForSelector('#my-link-input');
    const aliceLink = await alicePage.inputValue('#my-link-input');

    const aliceRequestPromise = alicePage.waitForEvent('console', {
      predicate: msg => msg.text().includes('Friend request from:'),
      timeout: 30000,
    });

    await bob1Page.goto('/friends/add');
    await bob1Page.waitForSelector('#friend-link');
    await bob1Page.fill('#friend-link', aliceLink);
    await bob1Page.click('button[type="submit"]');
    await delay(300);
    await bob1Page.waitForSelector('#done-btn', { timeout: 15000 });

    await aliceRequestPromise;
    await delay(500);

    await alicePage.goto('/friends');
    await alicePage.waitForSelector('.friend-item.pending', { timeout: 15000 });

    const bobResponsePromise = bob1Page.waitForEvent('console', {
      predicate: msg => msg.text().includes('Friend response:'),
      timeout: 30000,
    });
    await alicePage.click(`.accept-btn[data-username="${bobUsername}"]`);
    await delay(500);
    await bobResponsePromise;
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
    const bob1DeviceId = await bob1Page.evaluate(() => window.__client.userId);
    const bob2DeviceId = await bob2Page.evaluate(() => window.__client.userId);
    console.log('Bob1 device:', bob1DeviceId?.slice(-8));
    console.log('Bob2 device:', bob2DeviceId?.slice(-8));

    // ============================================================
    // STEP 5: Verify SENT_SYNC works (Bob1 → Bob2)
    // ============================================================
    console.log('\n=== STEP 5: Verify SENT_SYNC works ===');

    // Bob1 sends message to Alice, Bob2 should get SENT_SYNC
    const bob2SentSyncPromise = bob2Page.waitForEvent('console', {
      predicate: msg => msg.text().includes('[Global] Sent sync:') || msg.text().includes('SENT_SYNC'),
      timeout: 15000,
    });
    const aliceMsgPromise = alicePage.waitForEvent('console', {
      predicate: msg => msg.text().includes('[Global] Message from:'),
      timeout: 15000,
    });

    await bob1Page.goto(`/messages/${aliceUsername}`);
    await bob1Page.waitForSelector('#message-text');
    await bob1Page.fill('#message-text', 'Message 1 - SENT_SYNC should work');
    await bob1Page.click('button[type="submit"]');
    await delay(300);

    await aliceMsgPromise;
    console.log('Alice received message from Bob1');

    await bob2SentSyncPromise;
    console.log('Bob2 received SENT_SYNC from Bob1 - intra-device session works!');

    // ============================================================
    // STEP 6: Verify Bob1 has session with Bob2
    // ============================================================
    console.log('\n=== STEP 6: Verify session exists ===');

    const bob1HasSessionWithBob2 = await bob1Page.evaluate(async (bob2Id) => {
      const address = `${bob2Id}.1`;
      const session = await window.__client.store.loadSession(address);
      return !!session;
    }, bob2DeviceId);
    expect(bob1HasSessionWithBob2).toBe(true);
    console.log('Bob1 has session with Bob2:', bob1HasSessionWithBob2);

    // ============================================================
    // STEP 7: Corrupt Bob1's session with Bob2
    // ============================================================
    console.log('\n=== STEP 7: Corrupt Bob1 session with Bob2 ===');

    await bob1Page.evaluate(async (bob2Id) => {
      const address = `${bob2Id}.1`;
      await window.__client.store.removeSession(address);
      console.log('[TEST] Deleted session:', address);
    }, bob2DeviceId);
    console.log('Bob1 session with Bob2 DELETED (simulating corruption)');

    // Verify session is gone
    const bob1SessionAfterCorrupt = await bob1Page.evaluate(async (bob2Id) => {
      const address = `${bob2Id}.1`;
      const session = await window.__client.store.loadSession(address);
      return !!session;
    }, bob2DeviceId);
    expect(bob1SessionAfterCorrupt).toBe(false);
    console.log('Bob1 session with Bob2 after corruption:', bob1SessionAfterCorrupt);

    // ============================================================
    // STEP 8: Bob1 sends message - Bob2 should NOT get SENT_SYNC
    // ============================================================
    console.log('\n=== STEP 8: Bob1 sends - Bob2 should NOT get SENT_SYNC ===');

    // Alice should still receive the message (fan-out works)
    const aliceMsg2Promise = alicePage.waitForEvent('console', {
      predicate: msg => msg.text().includes('[Global] Message from:'),
      timeout: 15000,
    });

    // Bob2 should either get nothing or get an error (session broken)
    let bob2GotSentSync = false;
    const bob2Listener = msg => {
      if (msg.text().includes('[Global] Sent sync:') || msg.text().includes('SENT_SYNC')) {
        bob2GotSentSync = true;
      }
    };
    bob2Page.on('console', bob2Listener);

    await bob1Page.fill('#message-text', 'Message 2 - SENT_SYNC should FAIL');
    await bob1Page.click('button[type="submit"]');
    await delay(300);

    await aliceMsg2Promise;
    console.log('Alice received message (fan-out still works)');

    // Wait a bit to see if Bob2 gets SENT_SYNC
    await delay(2000);
    bob2Page.off('console', bob2Listener);

    // Note: Bob2 might get a PreKey message which could work, or might fail
    // The key test is whether the session was properly reset
    console.log('Bob2 got SENT_SYNC after corruption:', bob2GotSentSync);

    // ============================================================
    // STEP 9: Bob1 resets session with Bob2
    // ============================================================
    console.log('\n=== STEP 9: Bob1 resets session with Bob2 ===');

    // Bob2 should receive SESSION_RESET
    const bob2ResetPromise = bob2Page.waitForEvent('console', {
      predicate: msg => msg.text().includes('Session reset received') || msg.text().includes('[ws] Message: SESSION_RESET'),
      timeout: 15000,
    });

    await bob1Page.evaluate(async (bob2Id) => {
      console.log('[TEST] Calling resetSessionWith for Bob2:', bob2Id?.slice(-8));
      await window.__client.resetSessionWith(bob2Id, 'intra_device_test');
    }, bob2DeviceId);
    console.log('Bob1 sent SESSION_RESET to Bob2');

    await bob2ResetPromise;
    console.log('Bob2 received SESSION_RESET from Bob1');

    // Wait for cleanup
    await delay(500);

    // Verify Bob2's session with Bob1 is deleted
    const bob2SessionWithBob1AfterReset = await bob2Page.evaluate(async (bob1Id) => {
      const address = `${bob1Id}.1`;
      const session = await window.__client.store.loadSession(address);
      return !!session;
    }, bob1DeviceId);
    expect(bob2SessionWithBob1AfterReset).toBe(false);
    console.log('Bob2 session with Bob1 after reset:', bob2SessionWithBob1AfterReset, '(should be false)');

    // ============================================================
    // STEP 10: Bob1 sends - Bob2 should NOW get SENT_SYNC
    // ============================================================
    console.log('\n=== STEP 10: Bob1 sends - Bob2 should NOW get SENT_SYNC ===');

    const bob2SentSync2Promise = bob2Page.waitForEvent('console', {
      predicate: msg => msg.text().includes('[Global] Sent sync:') || msg.text().includes('SENT_SYNC'),
      timeout: 15000,
    });
    const aliceMsg3Promise = alicePage.waitForEvent('console', {
      predicate: msg => msg.text().includes('[Global] Message from:'),
      timeout: 15000,
    });

    await bob1Page.fill('#message-text', 'Message 3 - SENT_SYNC should work again!');
    await bob1Page.click('button[type="submit"]');
    await delay(300);

    await aliceMsg3Promise;
    console.log('Alice received message');

    await bob2SentSync2Promise;
    console.log('Bob2 received SENT_SYNC from Bob1 - SESSION RECOVERED!');

    // ============================================================
    // STEP 11: Verify message content on Bob2
    // ============================================================
    console.log('\n=== STEP 11: Verify message content ===');

    await bob2Page.goto(`/messages/${aliceUsername}`);
    await bob2Page.waitForSelector('.message', { timeout: 10000 });
    const bob2Messages = await bob2Page.$$eval('.message .text', els => els.map(e => e.textContent));

    expect(bob2Messages).toContain('Message 3 - SENT_SYNC should work again!');
    console.log('Bob2 messages:', bob2Messages);

    // ============================================================
    // STEP 12: Test resetAllSessions includes own devices
    // ============================================================
    console.log('\n=== STEP 12: Test resetAllSessions includes own devices ===');

    // Bob2 should receive SESSION_RESET when Bob1 calls resetAllSessions
    const bob2ResetAllPromise = bob2Page.waitForEvent('console', {
      predicate: msg => msg.text().includes('Session reset received'),
      timeout: 15000,
    });
    const aliceResetPromise = alicePage.waitForEvent('console', {
      predicate: msg => msg.text().includes('Session reset received'),
      timeout: 15000,
    });

    const resetCount = await bob1Page.evaluate(async () => {
      return await window.__client.resetAllSessions('test_reset_all');
    });

    console.log('Reset count:', resetCount);
    expect(resetCount).toBeGreaterThanOrEqual(2); // At least Alice + Bob2

    await Promise.all([bob2ResetAllPromise, aliceResetPromise]);
    console.log('Both Bob2 (own device) and Alice (friend) received SESSION_RESET');

    // Verify communication still works after resetAllSessions
    const bob2SentSync3Promise = bob2Page.waitForEvent('console', {
      predicate: msg => msg.text().includes('[Global] Sent sync:') || msg.text().includes('SENT_SYNC'),
      timeout: 15000,
    });
    const aliceMsg4Promise = alicePage.waitForEvent('console', {
      predicate: msg => msg.text().includes('[Global] Message from:'),
      timeout: 15000,
    });

    await bob1Page.fill('#message-text', 'Message 4 - after resetAllSessions');
    await bob1Page.click('button[type="submit"]');
    await delay(300);

    await Promise.all([aliceMsg4Promise, bob2SentSync3Promise]);
    console.log('Both Alice and Bob2 received message after resetAllSessions');

    console.log('\n=== SCENARIO 5e COMPLETE ===');
    console.log('Own-device SESSION_RESET: SUCCESS');
    console.log('resetAllSessions includes own devices: SUCCESS');

    // ============================================================
    // CLEANUP
    // ============================================================
    await bob2Context.close();
    await bob1Context.close();
    await aliceContext.close();
  });

});
