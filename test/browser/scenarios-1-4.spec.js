/**
 * E2E Scenarios 1-4 - Core Flow
 *
 * SCENARIOS:
 *   1. Register + Recovery Phrase + Persistence
 *   2. Logout + Login + WebSocket Connect
 *   3. Friend Request Flow (two users) + Persistence
 *   4. Send Message + Queued Delivery + Persistence
 *
 * Related tests:
 *   - scenario-5.spec.js - Multi-Device Linking
 *   - scenario-6.spec.js - Message Attachments
 *   - scenario-7.spec.js - Device Revocation
 */
import { test, expect } from '@playwright/test';

// Helper: 300ms delay between server requests (rate limiting)
const delay = (ms = 300) => new Promise(r => setTimeout(r, ms));

function randomUsername() {
  return 'test_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
}

test.describe('Scenarios 1-4: Core Flow', () => {

  test('Register, login, friends, messages', async ({ browser }) => {
    test.setTimeout(180000); // 3 minutes

    // ============================================================
    // SETUP: Create two browser contexts (Alice and Bob)
    // ============================================================
    const aliceContext = await browser.newContext();
    const bobContext = await browser.newContext();
    const page = await aliceContext.newPage();      // Alice's page
    const bobPage = await bobContext.newPage();     // Bob's page

    // Handle dialogs
    page.on('dialog', dialog => dialog.accept());
    bobPage.on('dialog', dialog => dialog.accept());

    // Debug logging
    page.on('console', msg => console.log('[alice]', msg.text()));
    bobPage.on('console', msg => console.log('[bob]', msg.text()));

    const username = randomUsername();       // Alice's username
    const bobUsername = randomUsername();    // Bob's username
    const password = 'testpass123';
    let savedPhrase = null;      // Alice's recovery phrase

    // ============================================================
    // SCENARIO 1: Register Alice + Recovery Phrase + Persistence
    // ============================================================
    console.log('\n=== SCENARIO 1: Register Alice ===');

    // 1. Go to register page
    await page.goto('/register');
    await page.waitForSelector('#username', { timeout: 30000 });
    console.log('Register page loaded');

    // 2. Fill registration form
    await page.fill('#username', username);
    await page.fill('#password', password);
    await page.fill('#confirm-password', password);

    // 3. Submit (this makes server request)
    await page.click('button[type="submit"]');
    await delay(300);

    // 4. Wait for phrase step
    await page.waitForSelector('.phrase-box', { timeout: 30000 });
    console.log('Phrase step reached');

    // 5. Capture the recovery phrase (12 words)
    const words = await page.$$eval('.phrase-box .word', els =>
      els.map(el => el.textContent.replace(/^\d+\.\s*/, '').trim())
    );
    savedPhrase = words.join(' ');
    expect(words.length).toBe(12);
    console.log('Captured recovery phrase:', savedPhrase);

    // 6. Confirm and continue
    await page.check('#confirm-saved');
    await page.click('#continue-btn');
    await delay(300);

    // 7. Wait for main app (stories page)
    await page.waitForURL('**/stories', { timeout: 30000 });
    console.log('Reached /stories');
    await delay(1000);

    // 8. REFRESH - verify persistence
    await page.reload();
    await delay(300);
    await page.waitForURL('**/stories', { timeout: 30000 });
    console.log('Session persisted through refresh');

    // 9. Verify IndexedDB stores exist
    const dbCheck = await page.evaluate(async () => {
      const dbs = await indexedDB.databases();
      const names = dbs.map(d => d.name);
      return {
        hasSignal: names.some(n => n?.includes('obscura_signal')),
        hasFriends: names.some(n => n?.includes('obscura_friends')),
        hasMessages: names.some(n => n?.includes('obscura_messages')),
      };
    });
    expect(dbCheck.hasSignal).toBe(true);
    console.log('IndexedDB stores created:', dbCheck);

    // ============================================================
    // SCENARIO 2: Logout + Login + WebSocket Connect
    // ============================================================
    console.log('\n=== SCENARIO 2: Logout + Login + Connect ===');

    // 10. Navigate to settings and logout (has modal confirmation)
    await page.goto('/settings');
    await page.waitForSelector('button[modal="logout-modal"]', { timeout: 10000 });
    await page.click('button[modal="logout-modal"]');
    await delay(300);

    // 10b. Confirm logout in modal
    await page.waitForSelector('#confirm-logout', { timeout: 5000 });
    await page.click('#confirm-logout');
    await delay(300);

    // 11. Should be back at login page
    await page.waitForURL('**/login', { timeout: 10000 });
    console.log('Logged out, at /login');

    // 12. Log back in with same credentials
    await page.fill('#username', username);
    await page.fill('#password', password);
    await page.click('button[type="submit"]');
    await delay(300);

    // 13. Should go to /stories (existing device login)
    await page.waitForURL('**/stories', { timeout: 30000 });
    console.log('Logged back in');

    // 14. Wait for WebSocket to connect (check repeatedly)
    let aliceWs = false;
    for (let i = 0; i < 10; i++) {
      await delay(500);
      aliceWs = await page.evaluate(() => {
        const client = window.__client;
        return client?.ws?.readyState === 1; // WebSocket.OPEN
      });
      if (aliceWs) break;
    }
    expect(aliceWs).toBe(true);
    console.log('WebSocket connected');

    // 15. Verify keys were NOT regenerated (same identity)
    const identityCheck = await page.evaluate(async () => {
      const client = window.__client;
      return {
        hasUserId: !!client?.userId,
        hasDeviceUUID: !!client?.deviceUUID,
        // Recovery phrase should be null (already consumed)
        phraseIsNull: client?.getRecoveryPhrase?.() === null,
      };
    });
    expect(identityCheck.hasUserId).toBe(true);
    expect(identityCheck.hasDeviceUUID).toBe(true);
    expect(identityCheck.phraseIsNull).toBe(true);
    console.log('Identity restored (not regenerated):', identityCheck);

    // 16. Refresh while connected
    // Wait for "Connected to gateway" log message as confirmation
    const gatewayPromise = page.waitForEvent('console', {
      predicate: msg => msg.text().includes('Connected to gateway'),
      timeout: 30000,
    });
    await page.reload();
    await gatewayPromise;
    console.log('WebSocket reconnected after refresh');

    console.log('\n=== SCENARIOS 1-2 COMPLETE ===\n');

    // ============================================================
    // SCENARIO 3: Friend Request Flow (Two Users)
    // ============================================================
    console.log('\n=== SCENARIO 3: Friend Request Flow ===');

    // --- Register Bob ---
    console.log('Registering Bob...');
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
    console.log('Bob registered');

    // --- Wait for Bob's WebSocket ---
    let bobWs = false;
    for (let i = 0; i < 10; i++) {
      await delay(500);
      bobWs = await bobPage.evaluate(() => window.__client?.ws?.readyState === 1);
      if (bobWs) break;
    }
    expect(bobWs).toBe(true);
    console.log('Bob WebSocket connected');

    // Re-check Alice is still connected (navigate to refresh client state)
    await page.goto('/stories');
    await page.waitForEvent('console', {
      predicate: msg => msg.text().includes('Connected to gateway'),
      timeout: 30000,
    });
    await delay(500); // Wait for state to fully settle
    const aliceDebug = await page.evaluate(() => ({
      hasClient: !!window.__client,
      hasWs: !!window.__client?.ws,
      wsReadyState: window.__client?.ws?.readyState,
      wsUrl: window.__client?.ws?.url,
    }));
    console.log('Alice WebSocket debug:', aliceDebug);
    aliceWs = aliceDebug.wsReadyState === 1;
    expect(aliceWs).toBe(true);
    console.log('Alice still connected');

    // --- Get Bob's shareable link ---
    await bobPage.goto('/friends/add');
    await bobPage.waitForSelector('#my-link-input');
    const bobLink = await bobPage.inputValue('#my-link-input');
    console.log('Bob link:', bobLink);

    // --- Alice sends friend request to Bob ---
    // Set up Bob's listener BEFORE Alice sends (to avoid race)
    const bobRequestPromise = bobPage.waitForEvent('console', {
      predicate: msg => msg.text().includes('Friend request from:'),
      timeout: 30000,
    });

    await page.goto('/friends/add');
    await page.waitForSelector('#friend-link');
    await page.fill('#friend-link', bobLink);
    await page.click('button[type="submit"]');
    await delay(300);

    await page.waitForSelector('#done-btn', { timeout: 15000 });
    console.log('Alice sent friend request to Bob');

    // Wait for Bob to receive the request
    await bobRequestPromise;
    await delay(500); // Allow IndexedDB persistence
    console.log('Bob received friend request');

    // --- Bob sees and accepts the request ---
    await bobPage.goto('/friends');
    await bobPage.waitForSelector('.friend-item.pending', { timeout: 15000 });
    console.log('Bob sees pending request');

    // Set up Alice's listener for the response BEFORE Bob accepts
    const aliceResponsePromise = page.waitForEvent('console', {
      predicate: msg => msg.text().includes('Friend response:'),
      timeout: 30000,
    });

    await bobPage.click(`.accept-btn[data-username="${username}"]`);
    await delay(500);
    console.log('Bob accepted request');

    // Wait for Alice to receive the response
    await aliceResponsePromise;
    await delay(500); // Allow IndexedDB persistence
    console.log('Alice received friend response');

    // --- Verify 4-digit verify codes via UI ---
    await page.goto('/friends');
    await page.waitForSelector(`.friend-item[data-username="${bobUsername}"] .verify-btn`, { timeout: 15000 });
    await page.click(`.friend-item[data-username="${bobUsername}"] .verify-btn`);
    await page.waitForURL('**/friends/verify/**', { timeout: 10000 });
    await page.waitForSelector('.safety-code', { timeout: 10000 });

    // Get the codes from the verify UI
    const verifyCodes = await page.$$eval('.safety-code', els => els.map(el => el.textContent));
    expect(verifyCodes.length).toBe(2);
    expect(verifyCodes[0]).toMatch(/^\d{4}$/); // Your code
    expect(verifyCodes[1]).toMatch(/^\d{4}$/); // Their code
    console.log('4-digit verify codes in UI:', { myCode: verifyCodes[0], theirCode: verifyCodes[1] });

    // Click "Codes Match" to go back
    await page.click('#match-btn');
    await page.waitForURL('**/friends', { timeout: 10000 });

    // --- Test: Codes don't match warning UI (Fix 3) ---
    await page.goto(`/friends/verify/${bobUsername}`);
    await page.waitForSelector('#no-match-btn', { timeout: 10000 });
    await page.click('#no-match-btn');
    await page.waitForSelector('.mismatch-warning', { timeout: 5000 });
    const warningVisible = await page.$('.mismatch-warning');
    expect(warningVisible).not.toBeNull();
    await page.click('#go-back-btn');
    await page.waitForURL('**/friends', { timeout: 10000 });
    console.log('Codes mismatch warning UI works ✓');

    // --- Verify both see each other in friends list (no badge for accepted) ---
    await bobPage.goto('/friends');
    await bobPage.waitForSelector(`.friend-item[data-username="${username}"]`, { timeout: 15000 });
    // Accepted friends have no badge - just verify they're in the list
    const bobHasAlice = await bobPage.$(`.friend-item[data-username="${username}"]`);
    expect(bobHasAlice).not.toBeNull();
    console.log('Bob sees Alice in friends list');

    await page.goto('/friends');
    await page.waitForSelector(`.friend-item[data-username="${bobUsername}"]`, { timeout: 15000 });
    const aliceHasBob = await page.$(`.friend-item[data-username="${bobUsername}"]`);
    expect(aliceHasBob).not.toBeNull();
    console.log('Alice sees Bob in friends list');

    // --- Verify persistence through refresh ---
    console.log('Testing persistence through refresh...');

    await page.reload();
    await page.waitForEvent('console', {
      predicate: msg => msg.text().includes('Connected to gateway'),
      timeout: 30000,
    });
    await page.goto('/friends');
    await page.waitForSelector(`.friend-item[data-username="${bobUsername}"]`, { timeout: 15000 });
    console.log('Alice still sees Bob after refresh');

    await bobPage.reload();
    await bobPage.waitForEvent('console', {
      predicate: msg => msg.text().includes('Connected to gateway'),
      timeout: 30000,
    });
    await bobPage.goto('/friends');
    await bobPage.waitForSelector(`.friend-item[data-username="${username}"]`, { timeout: 15000 });
    console.log('Bob still sees Alice after refresh');

    // --- Verify persistence through logout/login ---
    console.log('Testing persistence through logout/login...');

    // Alice logs out
    await page.goto('/settings');
    await page.click('button[modal="logout-modal"]');
    await delay(300);
    await page.click('#confirm-logout');
    await page.waitForURL('**/login');
    console.log('Alice logged out');

    // Bob logs out
    await bobPage.goto('/settings');
    await bobPage.click('button[modal="logout-modal"]');
    await delay(300);
    await bobPage.click('#confirm-logout');
    await bobPage.waitForURL('**/login');
    console.log('Bob logged out');

    // Alice logs back in
    await page.fill('#username', username);
    await page.fill('#password', password);
    await page.click('button[type="submit"]');
    await page.waitForURL('**/stories');

    aliceWs = false;
    for (let i = 0; i < 10; i++) {
      await delay(500);
      aliceWs = await page.evaluate(() => window.__client?.ws?.readyState === 1);
      if (aliceWs) break;
    }
    expect(aliceWs).toBe(true);
    console.log('Alice logged back in');

    // Bob logs back in
    await bobPage.fill('#username', bobUsername);
    await bobPage.fill('#password', password);
    await bobPage.click('button[type="submit"]');
    await bobPage.waitForURL('**/stories');

    bobWs = false;
    for (let i = 0; i < 10; i++) {
      await delay(500);
      bobWs = await bobPage.evaluate(() => window.__client?.ws?.readyState === 1);
      if (bobWs) break;
    }
    expect(bobWs).toBe(true);
    console.log('Bob logged back in');

    // Verify both still see each other
    await page.goto('/friends');
    await page.waitForSelector(`.friend-item[data-username="${bobUsername}"]`, { timeout: 15000 });
    console.log('Alice still sees Bob after logout/login');

    await bobPage.goto('/friends');
    await bobPage.waitForSelector(`.friend-item[data-username="${username}"]`, { timeout: 15000 });
    console.log('Bob still sees Alice after logout/login');

    console.log('\n=== SCENARIO 3 COMPLETE ===\n');

    // ============================================================
    // SCENARIO 4: Send Message
    // ============================================================
    console.log('\n=== SCENARIO 4: Send Message ===');

    // --- Both navigate to their respective chat views ---
    // Bob needs to be on the chat page to receive real-time updates
    await bobPage.goto(`/messages/${username}`);
    await bobPage.waitForSelector('#message-text');
    console.log('Bob is on chat page');

    // Alice navigates to chat with Bob
    await page.goto(`/messages/${bobUsername}`);
    await page.waitForSelector('#message-text');
    console.log('Alice is on chat page');

    // Alice types and sends message
    await page.fill('#message-text', 'Hello from Alice!');
    await page.click('button[type="submit"]');
    await delay(300);

    // Alice sees her sent message
    await page.waitForSelector('.message.sent');
    const aliceSentText = await page.$eval('.message.sent .text', el => el.textContent);
    expect(aliceSentText).toBe('Hello from Alice!');
    console.log('Alice sent message');

    // --- Bob sees the message in real-time (Chat view auto-updates) ---
    await bobPage.waitForSelector('.message.received', { timeout: 15000 });
    const bobReceivedText = await bobPage.$eval('.message.received .text', el => el.textContent);
    expect(bobReceivedText).toBe('Hello from Alice!');
    console.log('Bob sees Alice message in chat');

    // --- Bob replies ---
    // Set up Alice's listener
    const aliceMessagePromise = page.waitForEvent('console', {
      predicate: msg => msg.text().includes('[Global] Message from:'),
      timeout: 30000,
    });

    await bobPage.fill('#message-text', 'Hello from Bob!');
    await bobPage.click('button[type="submit"]');
    await delay(300);

    // Bob sees his sent message
    await bobPage.waitForSelector('.message.sent');
    const bobSentText = await bobPage.$eval('.message.sent .text', el => el.textContent);
    expect(bobSentText).toBe('Hello from Bob!');
    console.log('Bob sent reply');

    // Wait for Alice to receive
    await aliceMessagePromise;
    await delay(500);

    // Alice sees Bob's reply (Chat view auto-updates via client.on('message'))
    await page.waitForSelector('.message.received', { timeout: 15000 });
    const aliceReceivedText = await page.$eval('.message.received .text', el => el.textContent);
    expect(aliceReceivedText).toBe('Hello from Bob!');
    console.log('Alice sees Bob reply');

    // --- Test queued delivery: Bob logs out, Alice sends, Bob logs back in ---
    console.log('Testing queued message delivery (offline -> online)...');

    // Bob logs out
    await bobPage.goto('/settings');
    await bobPage.click('button[modal="logout-modal"]');
    await delay(300);
    await bobPage.click('#confirm-logout');
    await bobPage.waitForURL('**/login');
    console.log('Bob logged out for queued test');

    // Alice sends a message while Bob is offline
    await page.goto(`/messages/${bobUsername}`);
    await page.waitForSelector('#message-text');
    await page.fill('#message-text', 'Message while you were away!');
    await page.click('button[type="submit"]');
    await delay(300);
    await page.waitForSelector('.message.sent:last-child');
    console.log('Alice sent message while Bob offline');

    // Set up listener BEFORE Bob logs in (message arrives immediately on connect)
    const bobQueuedPromise = bobPage.waitForEvent('console', {
      predicate: msg => msg.text().includes('[Global] Message from:'),
      timeout: 30000,
    });

    // Bob logs back in
    await bobPage.fill('#username', bobUsername);
    await bobPage.fill('#password', password);
    await bobPage.click('button[type="submit"]');
    await bobPage.waitForURL('**/stories');

    // Wait for WebSocket to connect
    bobWs = false;
    for (let i = 0; i < 10; i++) {
      await delay(500);
      bobWs = await bobPage.evaluate(() => window.__client?.ws?.readyState === 1);
      if (bobWs) break;
    }
    expect(bobWs).toBe(true);
    console.log('Bob logged back in');

    // Wait for queued message to arrive
    await bobQueuedPromise;
    console.log('Bob received queued message');

    // Bob navigates to chat and sees the queued message
    await bobPage.goto(`/messages/${username}`);
    await bobPage.waitForSelector('.message', { timeout: 15000 });
    const bobQueuedMessages = await bobPage.$$eval('.message .text', els => els.map(el => el.textContent));
    expect(bobQueuedMessages).toContain('Message while you were away!');
    console.log('Bob sees queued message in chat');

    // --- Verify message persistence through refresh ---
    console.log('Testing message persistence through refresh...');

    await page.reload();
    await page.waitForEvent('console', {
      predicate: msg => msg.text().includes('Connected to gateway'),
      timeout: 30000,
    });
    await page.goto(`/messages/${bobUsername}`);
    await page.waitForSelector('.message', { timeout: 15000 });
    const aliceMessagesAfterRefresh = await page.$$eval('.message .text', els => els.map(el => el.textContent));
    expect(aliceMessagesAfterRefresh).toContain('Hello from Alice!');
    expect(aliceMessagesAfterRefresh).toContain('Hello from Bob!');
    console.log('Alice still sees messages after refresh');

    await bobPage.reload();
    await bobPage.waitForEvent('console', {
      predicate: msg => msg.text().includes('Connected to gateway'),
      timeout: 30000,
    });
    await bobPage.goto(`/messages/${username}`);
    await bobPage.waitForSelector('.message', { timeout: 15000 });
    const bobMessagesAfterRefresh = await bobPage.$$eval('.message .text', els => els.map(el => el.textContent));
    expect(bobMessagesAfterRefresh).toContain('Hello from Alice!');
    expect(bobMessagesAfterRefresh).toContain('Hello from Bob!');
    console.log('Bob still sees messages after refresh');

    // --- Verify message persistence through logout/login ---
    console.log('Testing message persistence through logout/login...');

    // Alice logs out
    await page.goto('/settings');
    await page.click('button[modal="logout-modal"]');
    await delay(300);
    await page.click('#confirm-logout');
    await page.waitForURL('**/login');
    console.log('Alice logged out');

    // Bob logs out
    await bobPage.goto('/settings');
    await bobPage.click('button[modal="logout-modal"]');
    await delay(300);
    await bobPage.click('#confirm-logout');
    await bobPage.waitForURL('**/login');
    console.log('Bob logged out');

    // Alice logs back in
    await page.fill('#username', username);
    await page.fill('#password', password);
    await page.click('button[type="submit"]');
    await page.waitForURL('**/stories');

    aliceWs = false;
    for (let i = 0; i < 10; i++) {
      await delay(500);
      aliceWs = await page.evaluate(() => window.__client?.ws?.readyState === 1);
      if (aliceWs) break;
    }
    expect(aliceWs).toBe(true);
    console.log('Alice logged back in');

    // Bob logs back in
    await bobPage.fill('#username', bobUsername);
    await bobPage.fill('#password', password);
    await bobPage.click('button[type="submit"]');
    await bobPage.waitForURL('**/stories');

    bobWs = false;
    for (let i = 0; i < 10; i++) {
      await delay(500);
      bobWs = await bobPage.evaluate(() => window.__client?.ws?.readyState === 1);
      if (bobWs) break;
    }
    expect(bobWs).toBe(true);
    console.log('Bob logged back in');

    // Verify messages persisted
    await page.goto(`/messages/${bobUsername}`);
    await page.waitForSelector('.message', { timeout: 15000 });
    const aliceMessagesAfterLogin = await page.$$eval('.message .text', els => els.map(el => el.textContent));
    expect(aliceMessagesAfterLogin).toContain('Hello from Alice!');
    expect(aliceMessagesAfterLogin).toContain('Hello from Bob!');
    console.log('Alice still sees messages after logout/login');

    await bobPage.goto(`/messages/${username}`);
    await bobPage.waitForSelector('.message', { timeout: 15000 });
    const bobMessagesAfterLogin = await bobPage.$$eval('.message .text', els => els.map(el => el.textContent));
    expect(bobMessagesAfterLogin).toContain('Hello from Alice!');
    expect(bobMessagesAfterLogin).toContain('Hello from Bob!');
    console.log('Bob still sees messages after logout/login');

    // --- Verify logs are being recorded ---
    console.log('Verifying logs...');
    await page.goto('/logs');
    await page.waitForSelector('.logs-list', { timeout: 10000 });

    // Check that we have logged events (gateway connect, send, receive)
    const eventCount = await page.$eval('ry-badge[variant="primary"]', el => el.textContent);
    const count = parseInt(eventCount);
    expect(count).toBeGreaterThan(0);
    console.log(`Alice has ${count} log events`);

    // Check for specific event types in the logs
    const logEvents = await page.$$eval('.log-event ry-badge', els => els.map(el => el.textContent));
    expect(logEvents.some(e => e.includes('send'))).toBe(true);
    console.log('Logs verified: send events present');

    console.log('\n=== SCENARIO 4 COMPLETE ===\n');

    // ============================================================
    // CLEANUP
    // ============================================================
    await aliceContext.close();
    await bobContext.close();
  });

});
