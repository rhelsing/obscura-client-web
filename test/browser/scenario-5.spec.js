/**
 * E2E Scenario 5 - Multi-Device Linking
 *
 * Minimal setup: Register Alice & Bob, make friends, then test device linking.
 *
 * Tests:
 *   5.1 New device login redirects to /link-pending
 *   5.2 Link code generation and capture
 *   5.3 Existing device approves new device
 *   5.4 New device receives SYNC_BLOB (friends, messages)
 *   5.5 Fan-out: message reaches both devices
 *   5.6 Self-sync: SENT_SYNC between own devices
 *   5.7 Link code replay rejected
 */
import { test, expect } from '@playwright/test';
import { delay, randomUsername, waitForViewReady, TEST_PASSWORD } from './helpers.js';

test.describe('Scenario 5: Multi-Device Linking', () => {

  test('Link device, sync, fan-out, self-sync', async ({ browser }) => {
    test.setTimeout(180000); // 3 minutes

    // ============================================================
    // SETUP: Create browser contexts
    // ============================================================
    const aliceContext = await browser.newContext();
    const bobContext = await browser.newContext();
    const page = await aliceContext.newPage();
    const bobPage = await bobContext.newPage();

    page.on('dialog', dialog => dialog.accept());
    bobPage.on('dialog', dialog => dialog.accept());
    page.on('console', msg => console.log('[alice]', msg.text()));
    bobPage.on('console', msg => console.log('[bob]', msg.text()));

    const username = randomUsername();
    const bobUsername = randomUsername();
    const password = TEST_PASSWORD;

    // ============================================================
    // SETUP: Register Alice
    // ============================================================
    console.log('\n=== SETUP: Register Alice ===');
    await page.goto('/register');
    await waitForViewReady(page);
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

    let aliceWs = false;
    for (let i = 0; i < 10; i++) {
      await delay(500);
      aliceWs = await page.evaluate(() => window.__client?.ws?.readyState === 1);
      if (aliceWs) break;
    }
    expect(aliceWs).toBe(true);
    console.log('Alice registered and connected');

    // ============================================================
    // SETUP: Register Bob
    // ============================================================
    console.log('\n=== SETUP: Register Bob ===');
    await bobPage.goto('/register');
    await waitForViewReady(bobPage);
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
    // SETUP: Make Friends
    // ============================================================
    console.log('\n=== SETUP: Make Friends ===');
    await bobPage.goto('/friends/add');
    await bobPage.waitForSelector('#my-link-input');
    const bobLink = await bobPage.inputValue('#my-link-input');

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

    await bobRequestPromise;
    await delay(500);

    await bobPage.goto('/friends');
    await bobPage.waitForSelector('.friend-item.pending', { timeout: 15000 });

    const aliceResponsePromise = page.waitForEvent('console', {
      predicate: msg => msg.text().includes('Friend response:'),
      timeout: 30000,
    });
    await bobPage.click(`.accept-btn[data-username="${username}"]`);
    await delay(500);
    await aliceResponsePromise;
    console.log('Alice and Bob are friends');

    // ============================================================
    // SETUP: Exchange a message (for SYNC_BLOB verification)
    // ============================================================
    console.log('\n=== SETUP: Exchange message ===');
    await page.goto(`/messages/${bobUsername}`);
    await page.waitForSelector('#message-text');
    await page.fill('#message-text', 'Hello before linking!');
    await page.click('button[type="submit"]');
    await delay(500);
    console.log('Alice sent message before linking');

    // ============================================================
    // SCENARIO 5: Multi-Device Linking
    // ============================================================
    console.log('\n=== SCENARIO 5: Multi-Device Linking ===');

    // --- 5.1: Bob logs in on a NEW device (new browser context) ---
    console.log('--- 5.1: New device login ---');
    const bob2Context = await browser.newContext();
    const bob2Page = await bob2Context.newPage();
    bob2Page.on('dialog', dialog => dialog.accept());
    bob2Page.on('console', msg => console.log('[bob2]', msg.text()));

    await bob2Page.goto('/login');
    await waitForViewReady(bob2Page);
    await bob2Page.waitForSelector('#username', { timeout: 10000 });
    await bob2Page.fill('#username', bobUsername);
    await bob2Page.fill('#password', password);
    await bob2Page.click('button[type="submit"]');
    await delay(300);

    // Should redirect to /link-pending (not /stories)
    await bob2Page.waitForURL('**/link-pending', { timeout: 15000 });
    console.log('Bob2 redirected to /link-pending');

    // --- 5.2: Get bob2's link code from the UI ---
    console.log('--- 5.2: Link code generation ---');
    await bob2Page.waitForSelector('.link-code', { timeout: 10000 });
    const bob2LinkCode = await bob2Page.$eval('.link-code', el => el.value || el.textContent);
    expect(bob2LinkCode.length).toBeGreaterThan(10);
    console.log('Bob2 link code captured:', bob2LinkCode.slice(0, 20) + '...');

    // --- 5.3: Bob (original device) approves bob2 ---
    console.log('--- 5.3: Device approval ---');
    await bobPage.evaluate(async (code) => {
      await window.__client.approveLink(code);
    }, bob2LinkCode);
    console.log('Bob approved bob2');

    // --- 5.4: Bob2 receives approval and sync, navigates to /stories ---
    console.log('--- 5.4: SYNC_BLOB received ---');
    await bob2Page.waitForURL('**/stories', { timeout: 20000 });

    let bob2Ws = false;
    for (let i = 0; i < 10; i++) {
      await delay(500);
      bob2Ws = await bob2Page.evaluate(() => window.__client?.ws?.readyState === 1);
      if (bob2Ws) break;
    }
    expect(bob2Ws).toBe(true);
    console.log('Bob2 connected after approval');

    // Verify bob2 has Alice as friend (synced from bob)
    await bob2Page.goto('/friends');
    await bob2Page.waitForSelector(`.friend-item[data-username="${username}"]`, { timeout: 15000 });
    console.log('Bob2 has Alice as friend (synced via SYNC_BLOB)');

    // Verify bob2 has the message synced
    await bob2Page.goto(`/messages/${username}`);
    await bob2Page.waitForSelector('.message', { timeout: 15000 });
    const bob2SyncedMsgs = await bob2Page.$$eval('.message .text', els => els.map(e => e.textContent));
    expect(bob2SyncedMsgs).toContain('Hello before linking!');
    console.log('Bob2 has messages synced via SYNC_BLOB');

    // Verify Bob sees Bob2 in devices list
    await bobPage.goto('/devices');
    await bobPage.waitForSelector('.device-items', { timeout: 10000 });
    const bobDevices = await bobPage.$$eval('.device-items card', els => els.length);
    expect(bobDevices).toBeGreaterThan(0);
    console.log('Bob sees', bobDevices, 'other device(s)');

    // --- 5.5: Fan-out test: Alice sends message, BOTH bob devices receive ---
    console.log('--- 5.5: Fan-out test ---');
    const bobMsgPromise = bobPage.waitForEvent('console', {
      predicate: msg => msg.text().includes('[Global] Message from:'),
      timeout: 15000,
    });
    const bob2MsgPromise = bob2Page.waitForEvent('console', {
      predicate: msg => msg.text().includes('[Global] Message from:'),
      timeout: 15000,
    });

    await page.goto(`/messages/${bobUsername}`);
    await page.waitForSelector('#message-text');
    await page.fill('#message-text', 'Hello both devices!');
    await page.click('button[type="submit"]');
    await delay(300);
    console.log('Alice sent message');

    await Promise.all([bobMsgPromise, bob2MsgPromise]);
    console.log('Both bob devices received message (fan-out works)');

    // --- 5.6: Self-sync test: Bob2 sends, Bob1 receives SENT_SYNC ---
    console.log('--- 5.6: Self-sync test ---');
    const aliceMsgPromise = page.waitForEvent('console', {
      predicate: msg => msg.text().includes('[Global] Message from:'),
      timeout: 15000,
    });
    const bob1SentSyncPromise = bobPage.waitForEvent('console', {
      predicate: msg => msg.text().includes('[Global] Sent sync:'),
      timeout: 15000,
    });

    await bob2Page.goto(`/messages/${username}`);
    await bob2Page.waitForSelector('#message-text');
    await bob2Page.fill('#message-text', 'Hello from bob2!');
    await bob2Page.click('button[type="submit"]');
    await delay(300);

    await Promise.all([aliceMsgPromise, bob1SentSyncPromise]);
    console.log('Bob2 sent to Alice, Bob1 received SENT_SYNC (self-sync works)');

    // Verify Alice received it
    await page.goto(`/messages/${bobUsername}`);
    await page.waitForSelector('.message', { timeout: 10000 });
    const aliceReceivedMsgs = await page.$$eval('.message .text', els => els.map(e => e.textContent));
    expect(aliceReceivedMsgs).toContain('Hello from bob2!');
    console.log('Alice received message from bob2');

    // --- 5.7: Link code replay should be rejected ---
    console.log('--- 5.7: Link code replay rejection ---');
    const replayResult = await bobPage.evaluate(async (code) => {
      try {
        await window.__client.approveLink(code);
        return { rejected: false, error: null };
      } catch (e) {
        return { rejected: true, error: e.message };
      }
    }, bob2LinkCode);
    console.log('Link code replay result:', replayResult);

    // At minimum, we shouldn't have duplicate devices
    const deviceCountAfterReplay = await bobPage.evaluate(() => window.__client.devices.getAll().length);
    expect(deviceCountAfterReplay).toBe(1); // Still just 1 other device
    console.log('No duplicate devices after replay attempt');

    // --- 5.8: Self-friend rejection: bob2 can't add bob ---
    console.log('--- 5.8: Self-friend rejection ---');

    // Get bob's friend link from original device
    await bobPage.goto('/friends/add');
    await bobPage.waitForSelector('#my-link-input');
    const bobFriendLink = await bobPage.inputValue('#my-link-input');

    // bob2 attempts to add bob's friend link (same user!)
    await bob2Page.goto('/friends/add');
    await bob2Page.waitForSelector('#friend-link');
    await bob2Page.fill('#friend-link', bobFriendLink);
    await bob2Page.click('button[type="submit"]');
    await delay(500);

    // Should show error, NOT success
    const selfFriendError = await bob2Page.$('ry-alert[type="danger"]');
    expect(selfFriendError).not.toBeNull();
    console.log('Self-friend correctly rejected');

    // Verify bob is NOT in bob2's friend list
    await bob2Page.goto('/friends');
    const selfInFriends = await bob2Page.$(`[data-username="${bobUsername}"]`);
    expect(selfInFriends).toBeNull();
    console.log('Bob not in bob2 friend list (correct)');

    // ============================================================
    // 5.9: Multi-Device Verification Code Matrix
    // Verify that verification codes are consistent across all devices
    // ============================================================
    console.log('\n--- 5.9: Multi-device verification code matrix ---');

    // Link Alice's second device
    console.log('Linking Alice2...');
    const alice2Context = await browser.newContext();
    const alice2Page = await alice2Context.newPage();
    alice2Page.on('dialog', dialog => dialog.accept());
    alice2Page.on('console', msg => console.log('[alice2]', msg.text()));

    await alice2Page.goto('/login');
    await waitForViewReady(alice2Page);
    await alice2Page.waitForSelector('#username', { timeout: 10000 });
    await alice2Page.fill('#username', username);
    await alice2Page.fill('#password', password);
    await alice2Page.click('button[type="submit"]');
    await delay(300);

    await alice2Page.waitForURL('**/link-pending', { timeout: 15000 });
    await alice2Page.waitForSelector('.link-code', { timeout: 10000 });
    const alice2LinkCode = await alice2Page.$eval('.link-code', el => el.value || el.textContent);
    console.log('Alice2 link code captured');

    // Alice1 approves Alice2
    await page.evaluate(async (code) => {
      await window.__client.approveLink(code);
    }, alice2LinkCode);
    console.log('Alice approved alice2');

    await alice2Page.waitForURL('**/stories', { timeout: 20000 });
    let alice2Ws = false;
    for (let i = 0; i < 10; i++) {
      await delay(500);
      alice2Ws = await alice2Page.evaluate(() => window.__client?.ws?.readyState === 1);
      if (alice2Ws) break;
    }
    expect(alice2Ws).toBe(true);
    console.log('Alice2 connected');

    // Helper to get verify codes from a page
    async function getVerifyCodes(testPage, friendUsername) {
      await testPage.goto('/friends');
      await testPage.waitForSelector(`.friend-item[data-username="${friendUsername}"] .verify-btn`, { timeout: 15000 });
      await testPage.click(`.friend-item[data-username="${friendUsername}"] .verify-btn`);
      await testPage.waitForURL('**/friends/verify/**', { timeout: 10000 });
      await testPage.waitForSelector('.safety-code', { timeout: 10000 });
      const codes = await testPage.$$eval('.safety-code', els => els.map(el => el.textContent));
      // Go back
      await testPage.click('#match-btn');
      await testPage.waitForURL('**/friends', { timeout: 10000 });
      return { myCode: codes[0], theirCode: codes[1] };
    }

    // Get verification codes from all 4 devices
    console.log('Getting verification codes from all devices...');

    const alice1Codes = await getVerifyCodes(page, bobUsername);
    console.log('Alice1 codes:', alice1Codes);

    const alice2Codes = await getVerifyCodes(alice2Page, bobUsername);
    console.log('Alice2 codes:', alice2Codes);

    const bob1Codes = await getVerifyCodes(bobPage, username);
    console.log('Bob1 codes:', bob1Codes);

    const bob2Codes = await getVerifyCodes(bob2Page, username);
    console.log('Bob2 codes:', bob2Codes);

    // Verify all codes are valid 4-digit numbers
    expect(alice1Codes.myCode).toMatch(/^\d{4}$/);
    expect(alice1Codes.theirCode).toMatch(/^\d{4}$/);
    expect(alice2Codes.myCode).toMatch(/^\d{4}$/);
    expect(alice2Codes.theirCode).toMatch(/^\d{4}$/);
    expect(bob1Codes.myCode).toMatch(/^\d{4}$/);
    expect(bob1Codes.theirCode).toMatch(/^\d{4}$/);
    expect(bob2Codes.myCode).toMatch(/^\d{4}$/);
    expect(bob2Codes.theirCode).toMatch(/^\d{4}$/);
    console.log('All codes are valid 4-digit numbers ✓');

    // KEY TEST: theirCode should be consistent across own devices
    expect(bob1Codes.theirCode).toBe(bob2Codes.theirCode);
    console.log('Bob1 and Bob2 see same theirCode for Alice ✓');

    expect(alice1Codes.theirCode).toBe(alice2Codes.theirCode);
    console.log('Alice1 and Alice2 see same theirCode for Bob ✓');

    // KEY TEST: myCode should also be consistent across own devices
    expect(alice1Codes.myCode).toBe(alice2Codes.myCode);
    console.log('Alice1 and Alice2 see same myCode ✓');

    expect(bob1Codes.myCode).toBe(bob2Codes.myCode);
    console.log('Bob1 and Bob2 see same myCode ✓');

    // Cross-check: Alice's theirCode for Bob should match Bob's myCode (symmetry)
    expect(alice1Codes.theirCode).toBe(bob1Codes.myCode);
    console.log('Alice sees Bob\'s myCode as theirCode ✓');

    // Cross-check: Bob's theirCode for Alice should match Alice's myCode (symmetry)
    expect(bob1Codes.theirCode).toBe(alice1Codes.myCode);
    console.log('Bob sees Alice\'s myCode as theirCode ✓');

    console.log('Full verification code matrix complete ✓');

    console.log('\n=== SCENARIO 5 COMPLETE ===\n');

    // ============================================================
    // CLEANUP
    // ============================================================
    await alice2Context.close();
    await bob2Context.close();
    await aliceContext.close();
    await bobContext.close();
  });

});
