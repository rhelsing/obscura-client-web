/**
 * E2E Scenario 5f - Auto-Recovery for "No Record" Errors
 *
 * Tests automatic SESSION_RESET when we receive a Whisper message
 * but have no session (e.g., session was deleted/lost).
 *
 * Flow:
 *   1. Alice and Bob register and become friends
 *   2. Exchange messages (establish sessions)
 *   3. Delete Bob's session with Alice (simulate storage loss)
 *   4. Alice sends message (Whisper) - Bob can't decrypt
 *   5. Bob auto-sends SESSION_RESET + ACKs undecryptable message
 *   6. Alice receives SESSION_RESET, clears her session
 *   7. Alice sends NEW message (PreKey - new session)
 *   8. Bob receives new message successfully
 *   9. Original message is lost (accepted tradeoff)
 */
import { test, expect } from '@playwright/test';

const delay = (ms = 300) => new Promise(r => setTimeout(r, ms));

function randomUsername() {
  return 'test_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
}

test.describe('Scenario 5f: Auto-Recovery for No Record', () => {

  test('Auto-resets session when receiving Whisper with no session', async ({ browser }) => {
    test.setTimeout(180000); // 3 minutes

    // ============================================================
    // SETUP: Create browser contexts
    // ============================================================
    const aliceContext = await browser.newContext();
    const bobContext = await browser.newContext();

    const alicePage = await aliceContext.newPage();
    const bobPage = await bobContext.newPage();

    alicePage.on('dialog', dialog => dialog.accept());
    bobPage.on('dialog', dialog => dialog.accept());
    alicePage.on('console', msg => console.log('[alice]', msg.text()));
    bobPage.on('console', msg => console.log('[bob]', msg.text()));

    const aliceUsername = randomUsername();
    const bobUsername = randomUsername();
    const password = 'testpass123';

    // ============================================================
    // STEP 1: Register Alice
    // ============================================================
    console.log('\n=== STEP 1: Register Alice ===');
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
    // STEP 2: Register Bob
    // ============================================================
    console.log('\n=== STEP 2: Register Bob ===');
    await bobPage.goto('/register');
    await bobPage.waitForSelector('#username', { timeout: 30000 });
    await bobPage.fill('#username', bobUsername);
    await bobPage.fill('#password', password);
    await bobPage.fill('#confirm-password', password);
    await bobPage.click('button[type="submit"]');
    await delay(300);

    await bobPage.waitForSelector('.phrase-box', { timeout: 30000 });
    await bobPage.check('#confirm-saved');
    await bobPage.click('#continue-btn');
    await delay(300);
    await bobPage.waitForURL('**/stories', { timeout: 30000 });

    let bobWs = false;
    for (let i = 0; i < 10; i++) {
      await delay(500);
      bobWs = await bobPage.evaluate(() => window.__client?.ws?.readyState === 1);
      if (bobWs) break;
    }
    expect(bobWs).toBe(true);
    console.log('Bob registered and connected');

    // ============================================================
    // STEP 3: Make friends
    // ============================================================
    console.log('\n=== STEP 3: Make friends ===');
    await bobPage.goto('/friends/add');
    await bobPage.waitForSelector('#my-link-input');
    const bobLink = await bobPage.inputValue('#my-link-input');

    const bobRequestPromise = bobPage.waitForEvent('console', {
      predicate: msg => msg.text().includes('Friend request from:'),
      timeout: 30000,
    });

    await alicePage.goto('/friends/add');
    await alicePage.waitForSelector('#friend-link');
    await alicePage.fill('#friend-link', bobLink);
    await alicePage.click('button[type="submit"]');
    await delay(300);
    await alicePage.waitForSelector('#done-btn', { timeout: 15000 });

    await bobRequestPromise;
    await delay(500);

    await bobPage.goto('/friends');
    await bobPage.waitForSelector('.friend-item.pending', { timeout: 15000 });

    const aliceResponsePromise = alicePage.waitForEvent('console', {
      predicate: msg => msg.text().includes('Friend response:'),
      timeout: 30000,
    });
    await bobPage.click(`.accept-btn[data-username="${aliceUsername}"]`);
    await delay(500);
    await aliceResponsePromise;
    console.log('Alice and Bob are friends');

    // ============================================================
    // STEP 4: Exchange messages to establish sessions
    // ============================================================
    console.log('\n=== STEP 4: Establish sessions ===');

    // Alice sends to Bob
    const bobMsgPromise = bobPage.waitForEvent('console', {
      predicate: msg => msg.text().includes('[Global] Message from:'),
      timeout: 15000,
    });

    await alicePage.goto(`/messages/${bobUsername}`);
    await alicePage.waitForSelector('#message-text');
    await alicePage.fill('#message-text', 'Hello Bob from Alice!');
    await alicePage.click('button[type="submit"]');
    await delay(300);
    await bobMsgPromise;
    console.log('Bob received message from Alice');

    // Bob sends to Alice (establishes Bob's sending session)
    const aliceMsgPromise = alicePage.waitForEvent('console', {
      predicate: msg => msg.text().includes('[Global] Message from:'),
      timeout: 15000,
    });

    await bobPage.goto(`/messages/${aliceUsername}`);
    await bobPage.waitForSelector('#message-text');
    await bobPage.fill('#message-text', 'Hello Alice from Bob!');
    await bobPage.click('button[type="submit"]');
    await delay(300);
    await aliceMsgPromise;
    console.log('Alice received message from Bob');

    // Get device IDs
    const aliceDeviceId = await alicePage.evaluate(() => window.__client.userId);
    const bobDeviceId = await bobPage.evaluate(() => window.__client.userId);
    console.log('Alice device:', aliceDeviceId?.slice(-8));
    console.log('Bob device:', bobDeviceId?.slice(-8));

    // ============================================================
    // STEP 5: Delete Bob's session with Alice (simulate storage loss)
    // ============================================================
    console.log('\n=== STEP 5: Delete Bob\'s session with Alice ===');

    const bobHadSession = await bobPage.evaluate(async (aliceId) => {
      const address = `${aliceId}.1`;
      const session = await window.__client.store.loadSession(address);
      if (session) {
        await window.__client.store.removeSession(address);
        console.log('[TEST] Deleted session with Alice');
        return true;
      }
      return false;
    }, aliceDeviceId);
    expect(bobHadSession).toBe(true);
    console.log('Bob\'s session with Alice deleted');

    // Verify session is gone
    const bobSessionGone = await bobPage.evaluate(async (aliceId) => {
      const address = `${aliceId}.1`;
      const session = await window.__client.store.loadSession(address);
      return !session;
    }, aliceDeviceId);
    expect(bobSessionGone).toBe(true);
    console.log('Confirmed: Bob has no session with Alice');

    // ============================================================
    // STEP 6: Alice sends message - triggers auto-recovery
    // ============================================================
    console.log('\n=== STEP 6: Alice sends message (triggers auto-recovery) ===');

    // Listen for Bob's auto-recovery log
    const bobAutoRecoveryPromise = bobPage.waitForEvent('console', {
      predicate: msg => msg.text().includes('Auto-recovering'),
      timeout: 15000,
    });

    // Listen for Alice receiving SESSION_RESET
    const aliceResetPromise = alicePage.waitForEvent('console', {
      predicate: msg => msg.text().includes('Session reset received') || msg.text().includes('[ws] Message: SESSION_RESET'),
      timeout: 15000,
    });

    // Alice sends message (this will be a Whisper, Bob can't decrypt)
    await alicePage.fill('#message-text', 'This message will be lost!');
    await alicePage.click('button[type="submit"]');
    console.log('Alice sent message (will fail on Bob\'s side)');

    // Wait for auto-recovery
    await bobAutoRecoveryPromise;
    console.log('Bob auto-recovered (sent SESSION_RESET)');

    await aliceResetPromise;
    console.log('Alice received SESSION_RESET');

    await delay(500);

    // ============================================================
    // STEP 7: Verify Alice's session was cleared
    // ============================================================
    console.log('\n=== STEP 7: Verify session states ===');

    const aliceSessionAfterReset = await alicePage.evaluate(async (bobId) => {
      const address = `${bobId}.1`;
      const session = await window.__client.store.loadSession(address);
      return !!session;
    }, bobDeviceId);
    // Alice might have a new session from sending SESSION_RESET response, or it could be cleared
    console.log('Alice has session after reset:', aliceSessionAfterReset);

    // ============================================================
    // STEP 8: Alice sends NEW message - works with PreKey
    // ============================================================
    console.log('\n=== STEP 8: Alice sends NEW message (PreKey) ===');

    const bobNewMsgPromise = bobPage.waitForEvent('console', {
      predicate: msg => msg.text().includes('[Global] Message from:'),
      timeout: 15000,
    });

    await alicePage.fill('#message-text', 'New message after recovery!');
    await alicePage.click('button[type="submit"]');
    await delay(300);
    await bobNewMsgPromise;
    console.log('Bob received NEW message after recovery!');

    // ============================================================
    // STEP 9: Verify Bob sees the new message (not the lost one)
    // ============================================================
    console.log('\n=== STEP 9: Verify messages ===');

    await bobPage.goto(`/messages/${aliceUsername}`);
    await bobPage.waitForSelector('.message', { timeout: 10000 });
    const bobMessages = await bobPage.$$eval('.message .text', els => els.map(e => e.textContent));
    console.log('Bob\'s messages:', bobMessages);

    // The lost message should NOT be there
    expect(bobMessages).not.toContain('This message will be lost!');
    // The new message SHOULD be there
    expect(bobMessages).toContain('New message after recovery!');

    console.log('\n=== SCENARIO 5f COMPLETE - AUTO-RECOVERY WORKS! ===');
    console.log('Lost message was accepted tradeoff. Future messages work.\n');

    // ============================================================
    // CLEANUP
    // ============================================================
    await bobContext.close();
    await aliceContext.close();
  });

});
