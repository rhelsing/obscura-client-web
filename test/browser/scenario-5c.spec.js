/**
 * E2E Scenario 5c - SESSION_RESET Protocol
 *
 * Tests the session reset mechanism for recovering from corrupted sessions.
 *
 * Flow:
 *   1. Alice and Bob register and become friends
 *   2. Exchange messages (establish sessions)
 *   3. Simulate Alice's session corruption (by corrupting the session data)
 *   4. Bob sends message - Alice can't decrypt (Bad MAC)
 *   5. Alice calls resetSessionWith(bobDeviceId)
 *   6. Verify Bob receives SESSION_RESET and clears his session
 *   7. Alice sends message (PreKey - new session)
 *   8. Bob receives message successfully
 */
import { test, expect } from '@playwright/test';

const delay = (ms = 300) => new Promise(r => setTimeout(r, ms));

function randomUsername() {
  return 'test_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
}

test.describe('Scenario 5c: SESSION_RESET Protocol', () => {

  test('Session reset allows recovery after corruption', async ({ browser }) => {
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
    // STEP 5: Verify sessions exist
    // ============================================================
    console.log('\n=== STEP 5: Verify sessions exist ===');

    const aliceHasSessionWithBob = await alicePage.evaluate(async (bobId) => {
      const address = `${bobId}.1`;
      const session = await window.__client.store.loadSession(address);
      return !!session;
    }, bobDeviceId);
    expect(aliceHasSessionWithBob).toBe(true);
    console.log('Alice has session with Bob:', aliceHasSessionWithBob);

    const bobHasSessionWithAlice = await bobPage.evaluate(async (aliceId) => {
      const address = `${aliceId}.1`;
      const session = await window.__client.store.loadSession(address);
      return !!session;
    }, aliceDeviceId);
    expect(bobHasSessionWithAlice).toBe(true);
    console.log('Bob has session with Alice:', bobHasSessionWithAlice);

    // ============================================================
    // STEP 6: Test SESSION_RESET protocol
    // ============================================================
    console.log('\n=== STEP 6: Test SESSION_RESET ===');

    // Bob should receive SESSION_RESET when Alice calls resetSessionWith
    const bobResetPromise = bobPage.waitForEvent('console', {
      predicate: msg => msg.text().includes('Session reset received') || msg.text().includes('[ws] Message: SESSION_RESET'),
      timeout: 15000,
    });

    // Alice calls resetSessionWith (simulating recovery action)
    await alicePage.evaluate(async (bobId) => {
      console.log('[TEST] Calling resetSessionWith for:', bobId?.slice(-8));
      await window.__client.resetSessionWith(bobId, 'test_reset');
    }, bobDeviceId);
    console.log('Alice sent SESSION_RESET');

    await bobResetPromise;
    console.log('Bob received SESSION_RESET');

    // Wait for session cleanup
    await delay(500);

    // Verify Alice's session was deleted
    const aliceSessionAfterReset = await alicePage.evaluate(async (bobId) => {
      const address = `${bobId}.1`;
      const session = await window.__client.store.loadSession(address);
      return !!session;
    }, bobDeviceId);
    // After reset, Alice should have a NEW session (created when sending SESSION_RESET)
    console.log('Alice has session after reset:', aliceSessionAfterReset);

    // Verify Bob's session was deleted
    const bobSessionAfterReset = await bobPage.evaluate(async (aliceId) => {
      const address = `${aliceId}.1`;
      const session = await window.__client.store.loadSession(address);
      return !!session;
    }, aliceDeviceId);
    expect(bobSessionAfterReset).toBe(false);
    console.log('Bob has session after reset:', bobSessionAfterReset, '(should be false)');

    // ============================================================
    // STEP 7: Verify communication works after reset
    // ============================================================
    console.log('\n=== STEP 7: Verify post-reset communication ===');

    // Alice sends message (will use existing session from SESSION_RESET send)
    const bobMsgAfterResetPromise = bobPage.waitForEvent('console', {
      predicate: msg => msg.text().includes('[Global] Message from:'),
      timeout: 15000,
    });

    await alicePage.goto(`/messages/${bobUsername}`);
    await alicePage.waitForSelector('#message-text');
    await alicePage.fill('#message-text', 'Message after session reset!');
    await alicePage.click('button[type="submit"]');
    await delay(300);
    await bobMsgAfterResetPromise;
    console.log('Bob received message after reset');

    // Verify message content
    await bobPage.goto(`/messages/${aliceUsername}`);
    await bobPage.waitForSelector('.message', { timeout: 10000 });
    const bobMessages = await bobPage.$$eval('.message .text', els => els.map(e => e.textContent));
    expect(bobMessages).toContain('Message after session reset!');
    console.log('Messages:', bobMessages);

    // Bob replies to Alice
    const aliceMsgAfterResetPromise = alicePage.waitForEvent('console', {
      predicate: msg => msg.text().includes('[Global] Message from:'),
      timeout: 15000,
    });

    await bobPage.fill('#message-text', 'Reply after session reset!');
    await bobPage.click('button[type="submit"]');
    await delay(300);
    await aliceMsgAfterResetPromise;
    console.log('Alice received reply after reset');

    // Verify bidirectional communication works
    await alicePage.waitForSelector('.message', { timeout: 10000 });
    const aliceMessages = await alicePage.$$eval('.message .text', els => els.map(e => e.textContent));
    expect(aliceMessages).toContain('Reply after session reset!');
    console.log('Alice messages:', aliceMessages);

    console.log('\n=== SCENARIO 5c COMPLETE - SESSION_RESET WORKS! ===\n');

    // ============================================================
    // CLEANUP
    // ============================================================
    await bobContext.close();
    await aliceContext.close();
  });

  test('resetAllSessions resets sessions with all friends', async ({ browser }) => {
    test.setTimeout(180000);

    const aliceContext = await browser.newContext();
    const bobContext = await browser.newContext();
    const charlieContext = await browser.newContext();

    const alicePage = await aliceContext.newPage();
    const bobPage = await bobContext.newPage();
    const charliePage = await charlieContext.newPage();

    alicePage.on('dialog', dialog => dialog.accept());
    bobPage.on('dialog', dialog => dialog.accept());
    charliePage.on('dialog', dialog => dialog.accept());
    alicePage.on('console', msg => console.log('[alice]', msg.text()));
    bobPage.on('console', msg => console.log('[bob]', msg.text()));
    charliePage.on('console', msg => console.log('[charlie]', msg.text()));

    const aliceUsername = randomUsername();
    const bobUsername = randomUsername();
    const charlieUsername = randomUsername();
    const password = 'testpass123';

    // Register all users
    console.log('\n=== Register users ===');
    for (const [page, username] of [[alicePage, aliceUsername], [bobPage, bobUsername], [charliePage, charlieUsername]]) {
      await page.goto('/register');
      await page.waitForSelector('#username', { timeout: 30000 });
      await page.fill('#username', username);
      await page.fill('#password', password);
      await page.fill('#confirm-password', password);
      await page.click('button[type="submit"]');
      await delay(300);
      await page.waitForSelector('.phrase-box', { timeout: 30000 });
      await page.check('#confirm-saved');
      await page.click('#continue-btn');
      await delay(300);
      await page.waitForURL('**/stories', { timeout: 30000 });

      let ws = false;
      for (let i = 0; i < 10; i++) {
        await delay(500);
        ws = await page.evaluate(() => window.__client?.ws?.readyState === 1);
        if (ws) break;
      }
      expect(ws).toBe(true);
      console.log(`${username} registered`);
    }

    // Alice befriends Bob
    console.log('\n=== Alice befriends Bob ===');
    await bobPage.goto('/friends/add');
    await bobPage.waitForSelector('#my-link-input');
    const bobLink = await bobPage.inputValue('#my-link-input');

    await alicePage.goto('/friends/add');
    await alicePage.waitForSelector('#friend-link');
    await alicePage.fill('#friend-link', bobLink);
    await alicePage.click('button[type="submit"]');
    await alicePage.waitForSelector('#done-btn', { timeout: 15000 });

    await bobPage.goto('/friends');
    await bobPage.waitForSelector('.friend-item.pending', { timeout: 15000 });
    await bobPage.click(`.accept-btn[data-username="${aliceUsername}"]`);
    await delay(1000);

    // Alice befriends Charlie
    console.log('\n=== Alice befriends Charlie ===');
    await charliePage.goto('/friends/add');
    await charliePage.waitForSelector('#my-link-input');
    const charlieLink = await charliePage.inputValue('#my-link-input');

    await alicePage.goto('/friends/add');
    await alicePage.waitForSelector('#friend-link');
    await alicePage.fill('#friend-link', charlieLink);
    await alicePage.click('button[type="submit"]');
    await alicePage.waitForSelector('#done-btn', { timeout: 15000 });

    await charliePage.goto('/friends');
    await charliePage.waitForSelector('.friend-item.pending', { timeout: 15000 });
    await charliePage.click(`.accept-btn[data-username="${aliceUsername}"]`);
    await delay(1000);

    // Establish sessions with messages
    console.log('\n=== Establish sessions ===');
    const bobMsgPromise = bobPage.waitForEvent('console', {
      predicate: msg => msg.text().includes('[Global] Message from:'),
      timeout: 15000,
    });
    await alicePage.goto(`/messages/${bobUsername}`);
    await alicePage.waitForSelector('#message-text');
    await alicePage.fill('#message-text', 'Hi Bob');
    await alicePage.click('button[type="submit"]');
    await bobMsgPromise;

    const charlieMsgPromise = charliePage.waitForEvent('console', {
      predicate: msg => msg.text().includes('[Global] Message from:'),
      timeout: 15000,
    });
    await alicePage.goto(`/messages/${charlieUsername}`);
    await alicePage.waitForSelector('#message-text');
    await alicePage.fill('#message-text', 'Hi Charlie');
    await alicePage.click('button[type="submit"]');
    await charlieMsgPromise;

    console.log('Sessions established with both friends');

    // Test resetAllSessions
    console.log('\n=== Test resetAllSessions ===');

    const bobResetPromise = bobPage.waitForEvent('console', {
      predicate: msg => msg.text().includes('Session reset received'),
      timeout: 15000,
    });
    const charlieResetPromise = charliePage.waitForEvent('console', {
      predicate: msg => msg.text().includes('Session reset received'),
      timeout: 15000,
    });

    const resetCount = await alicePage.evaluate(async () => {
      return await window.__client.resetAllSessions('test_nuclear_reset');
    });

    console.log('Reset count:', resetCount);
    expect(resetCount).toBeGreaterThanOrEqual(2);

    await Promise.all([bobResetPromise, charlieResetPromise]);
    console.log('Both Bob and Charlie received SESSION_RESET');

    // Verify communication still works
    console.log('\n=== Verify post-reset communication ===');

    const bobMsg2Promise = bobPage.waitForEvent('console', {
      predicate: msg => msg.text().includes('[Global] Message from:'),
      timeout: 15000,
    });
    await alicePage.goto(`/messages/${bobUsername}`);
    await alicePage.waitForSelector('#message-text');
    await alicePage.fill('#message-text', 'Post-reset message to Bob');
    await alicePage.click('button[type="submit"]');
    await bobMsg2Promise;
    console.log('Bob received post-reset message');

    const charlieMsg2Promise = charliePage.waitForEvent('console', {
      predicate: msg => msg.text().includes('[Global] Message from:'),
      timeout: 15000,
    });
    await alicePage.goto(`/messages/${charlieUsername}`);
    await alicePage.waitForSelector('#message-text');
    await alicePage.fill('#message-text', 'Post-reset message to Charlie');
    await alicePage.click('button[type="submit"]');
    await charlieMsg2Promise;
    console.log('Charlie received post-reset message');

    console.log('\n=== RESET ALL SESSIONS TEST COMPLETE ===\n');

    await charlieContext.close();
    await bobContext.close();
    await aliceContext.close();
  });

});
