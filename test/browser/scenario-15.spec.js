/**
 * E2E Scenario 15 - Linked Device Data Persistence
 *
 * Tests that a linked device retains its data after logout and re-login.
 *
 * Flow:
 *   1. Alice1 registers
 *   2. Bob registers
 *   3. Alice1 and Bob become friends
 *   4. Alice1 sends message to Bob
 *   5. Alice2 links to Alice's account, receives SYNC_BLOB with friends/messages
 *   6. Alice2 verifies it can see the message
 *   7. Alice2 logs out
 *   8. Alice2 logs back in
 *   9. Alice2 should STILL see the message (data persisted)
 */
import { test, expect } from '@playwright/test';
import { delay, randomUsername, waitForViewReady } from './helpers.js';

test.describe('Scenario 15: Linked Device Data Persistence', () => {

  test('Linked device retains data after logout and re-login', async ({ browser }) => {
    test.setTimeout(180000); // 3 minutes

    // ============================================================
    // SETUP: Create browser contexts
    // ============================================================
    const alice1Context = await browser.newContext();
    const alice2Context = await browser.newContext();
    const bobContext = await browser.newContext();

    const alice1Page = await alice1Context.newPage();
    const alice2Page = await alice2Context.newPage();
    const bobPage = await bobContext.newPage();

    alice1Page.on('dialog', dialog => dialog.accept());
    alice2Page.on('dialog', dialog => dialog.accept());
    bobPage.on('dialog', dialog => dialog.accept());

    alice1Page.on('console', msg => console.log('[alice1]', msg.text()));
    alice2Page.on('console', msg => console.log('[alice2]', msg.text()));
    bobPage.on('console', msg => console.log('[bob]', msg.text()));

    const aliceUsername = randomUsername();
    const bobUsername = randomUsername();
    const password = 'testpass123';

    // ============================================================
    // STEP 1: Register Alice1
    // ============================================================
    console.log('\n=== STEP 1: Register Alice1 ===');
    await alice1Page.goto('/register');
    await waitForViewReady(alice1Page);
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
    // STEP 2: Register Bob
    // ============================================================
    console.log('\n=== STEP 2: Register Bob ===');
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

    // Get Bob's userId for befriend call
    const bobUserId = await bobPage.evaluate(() => window.__client.userId);

    // ============================================================
    // STEP 3: Alice1 and Bob become friends
    // ============================================================
    console.log('\n=== STEP 3: Alice1 and Bob become friends ===');

    await alice1Page.evaluate(async ({ userId, username }) => {
      await window.__client.befriend(userId, username);
    }, { userId: bobUserId, username: bobUsername });
    console.log('Alice sent friend request to Bob');

    await delay(1000);

    // Bob accepts via UI
    await bobPage.goto('/friends');
    await bobPage.waitForSelector('.friend-item.pending', { timeout: 15000 });
    await bobPage.click(`.accept-btn[data-username="${aliceUsername}"]`);
    console.log('Bob accepted friend request');

    await delay(1000);

    const aliceHasBob = await alice1Page.evaluate((username) => {
      return window.__client.friends.getAll().some(f => f.username === username);
    }, bobUsername);
    expect(aliceHasBob).toBe(true);
    console.log('Alice and Bob are now friends');

    // ============================================================
    // STEP 4: Alice1 sends message to Bob
    // ============================================================
    console.log('\n=== STEP 4: Alice1 sends message to Bob ===');

    const testMessage = 'Hello from Alice1! ' + Date.now();

    await alice1Page.evaluate(async ({ username, message }) => {
      await window.__client.send(username, { text: message });
    }, { username: bobUsername, message: testMessage });
    console.log('Alice1 sent message:', testMessage);

    await delay(1000);

    // Verify message is stored on Alice1
    const alice1HasMessage = await alice1Page.evaluate(async ({ bobUsername, expectedText }) => {
      const messages = await window.__client.getMessages(bobUsername);
      return messages.some(m => m.content === expectedText || m.text === expectedText);
    }, { bobUsername, expectedText: testMessage });
    expect(alice1HasMessage).toBe(true);
    console.log('Alice1 has the message stored');

    // ============================================================
    // STEP 5: Alice2 links to Alice's account
    // ============================================================
    console.log('\n=== STEP 5: Alice2 links to Alice account ===');

    await alice2Page.goto('/login');
    await waitForViewReady(alice2Page);
    await alice2Page.waitForSelector('#username', { timeout: 10000 });
    await alice2Page.fill('#username', aliceUsername);
    await alice2Page.fill('#password', password);
    await alice2Page.click('button[type="submit"]');
    await delay(300);

    await alice2Page.waitForURL('**/link-pending', { timeout: 15000 });
    await alice2Page.waitForSelector('.link-code', { timeout: 10000 });
    const alice2LinkCode = await alice2Page.$eval('.link-code', el => el.value || el.textContent);
    console.log('Alice2 link code:', alice2LinkCode.slice(0, 20) + '...');

    // Alice1 approves Alice2
    await alice1Page.evaluate(async (code) => {
      await window.__client.approveLink(code);
      await window.__client.announceDevices();
    }, alice2LinkCode);

    await alice2Page.waitForURL('**/stories', { timeout: 20000 });

    let alice2Ws = false;
    for (let i = 0; i < 10; i++) {
      await delay(500);
      alice2Ws = await alice2Page.evaluate(() => window.__client?.ws?.readyState === 1);
      if (alice2Ws) break;
    }
    expect(alice2Ws).toBe(true);
    console.log('Alice2 linked and connected');

    // ============================================================
    // STEP 6: Verify Alice2 can see the message (via SYNC_BLOB)
    // ============================================================
    console.log('\n=== STEP 6: Verify Alice2 has the message ===');

    await delay(1000); // Give time for sync to complete

    const alice2HasMessageBefore = await alice2Page.evaluate(async ({ bobUsername, expectedText }) => {
      const messages = await window.__client.getMessages(bobUsername);
      console.log('Alice2 messages for Bob:', messages.length);
      return messages.some(m => m.content === expectedText || m.text === expectedText);
    }, { bobUsername, expectedText: testMessage });
    expect(alice2HasMessageBefore).toBe(true);
    console.log('Alice2 can see the message after linking');

    // Also verify Alice2 has Bob as friend
    const alice2HasBob = await alice2Page.evaluate((username) => {
      return window.__client.friends.getAll().some(f => f.username === username);
    }, bobUsername);
    expect(alice2HasBob).toBe(true);
    console.log('Alice2 has Bob as friend');

    // ============================================================
    // STEP 7: Alice2 logs out
    // ============================================================
    console.log('\n=== STEP 7: Alice2 logs out ===');

    // Navigate to settings and logout
    await alice2Page.goto('/settings');
    await delay(500);

    // Click "Log Out" button to open the confirmation modal
    await alice2Page.click('button[modal="logout-modal"]');
    await delay(300);

    // Click the confirm logout button in the modal
    await alice2Page.click('#confirm-logout');

    await alice2Page.waitForURL('**/login', { timeout: 10000 });
    console.log('Alice2 logged out');

    // ============================================================
    // STEP 8: Alice2 logs back in
    // ============================================================
    console.log('\n=== STEP 8: Alice2 logs back in ===');

    await waitForViewReady(alice2Page);
    await alice2Page.waitForSelector('#username', { timeout: 10000 });
    await alice2Page.fill('#username', aliceUsername);
    await alice2Page.fill('#password', password);
    await alice2Page.click('button[type="submit"]');
    await delay(500);

    // Should go directly to stories (existing device, not link-pending)
    await alice2Page.waitForURL('**/stories', { timeout: 15000 });
    console.log('Alice2 logged back in successfully');

    // Wait for WebSocket
    let alice2WsAfter = false;
    for (let i = 0; i < 10; i++) {
      await delay(500);
      alice2WsAfter = await alice2Page.evaluate(() => window.__client?.ws?.readyState === 1);
      if (alice2WsAfter) break;
    }
    expect(alice2WsAfter).toBe(true);
    console.log('Alice2 WebSocket connected after re-login');

    // ============================================================
    // STEP 9: Verify Alice2 STILL has the message
    // ============================================================
    console.log('\n=== STEP 9: Verify Alice2 still has the message ===');

    await delay(1000);

    const alice2HasMessageAfter = await alice2Page.evaluate(async ({ bobUsername, expectedText }) => {
      const messages = await window.__client.getMessages(bobUsername);
      console.log('Alice2 messages for Bob after re-login:', messages.length);
      return messages.some(m => m.content === expectedText || m.text === expectedText);
    }, { bobUsername, expectedText: testMessage });
    expect(alice2HasMessageAfter).toBe(true);
    console.log('Alice2 STILL has the message after logout/re-login');

    // Verify Alice2 still has Bob as friend
    const alice2StillHasBob = await alice2Page.evaluate((username) => {
      return window.__client.friends.getAll().some(f => f.username === username);
    }, bobUsername);
    expect(alice2StillHasBob).toBe(true);
    console.log('Alice2 still has Bob as friend after logout/re-login');

    console.log('\n=== SCENARIO 15 COMPLETE ===\n');

    // ============================================================
    // CLEANUP
    // ============================================================
    await alice1Context.close();
    await alice2Context.close();
    await bobContext.close();
  });

});
