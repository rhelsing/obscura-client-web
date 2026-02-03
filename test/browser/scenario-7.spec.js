/**
 * E2E Scenario 7 - Device Revocation
 *
 * Setup: Alice + Bob (2 devices: bob1, bob2), friends, messages exchanged
 *
 * Tests:
 *   7.1 Exchange messages (alice, bob1, bob2)
 *   7.2 Bob1 revokes bob2 using recovery phrase
 *   7.3 Everyone notified (revocation announce)
 *   7.4 Bob2's messages disappear
 *   7.5 Bob2 self-bricks (wipes data, redirects to login)
 */
import { test, expect } from '@playwright/test';
import { delay, randomUsername, waitForViewReady } from './helpers.js';

test.describe('Scenario 7: Device Revocation', () => {

  test('Revoke device, messages disappear', async ({ browser }) => {
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
    bobPage.on('console', msg => console.log('[bob1]', msg.text()));

    const username = randomUsername();
    const bobUsername = randomUsername();
    const password = 'testpass123';
    let bobSavedPhrase = null;

    // ============================================================
    // SETUP: Register Alice
    // ============================================================
    console.log('\n=== SETUP: Register Alice ===');
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

    let aliceWs = false;
    for (let i = 0; i < 10; i++) {
      await delay(500);
      aliceWs = await page.evaluate(() => window.__client?.ws?.readyState === 1);
      if (aliceWs) break;
    }
    expect(aliceWs).toBe(true);
    console.log('Alice registered and connected');

    // ============================================================
    // SETUP: Register Bob (capture recovery phrase for revocation)
    // ============================================================
    console.log('\n=== SETUP: Register Bob ===');
    await bobPage.goto('/register');
    await bobPage.waitForSelector('#username', { timeout: 30000 });
    await bobPage.fill('#username', bobUsername);
    await bobPage.fill('#password', password);
    await bobPage.fill('#confirm-password', password);
    await bobPage.click('button[type="submit"]');
    await delay(300);

    await bobPage.waitForSelector('.phrase-box', { timeout: 30000 });
    // Capture Bob's recovery phrase for device revocation
    const bobWords = await bobPage.$$eval('.phrase-box .word', els =>
      els.map(el => el.textContent.replace(/^\d+\.\s*/, '').trim())
    );
    bobSavedPhrase = bobWords.join(' ');
    expect(bobWords.length).toBe(12);
    console.log('Captured Bob recovery phrase:', bobSavedPhrase.split(' ').slice(0, 3).join(' ') + '...');

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
    console.log('Bob1 registered and connected');

    // ============================================================
    // SETUP: Make Friends (Alice + Bob)
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
    // SETUP: Link Bob2
    // ============================================================
    console.log('\n=== SETUP: Link Bob2 ===');
    const bob2Context = await browser.newContext();
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

    await bobPage.evaluate(async (code) => {
      await window.__client.approveLink(code);
    }, bob2LinkCode);

    await bob2Page.waitForURL('**/stories', { timeout: 20000 });

    let bob2Ws = false;
    for (let i = 0; i < 10; i++) {
      await delay(500);
      bob2Ws = await bob2Page.evaluate(() => window.__client?.ws?.readyState === 1);
      if (bob2Ws) break;
    }
    expect(bob2Ws).toBe(true);
    console.log('Bob2 linked and connected');

    // Wait for friends to sync via SYNC_BLOB (with devices)
    await bob2Page.waitForFunction(
      () => {
        const friends = window.__client?.friends?.getAll();
        if (!friends || friends.length === 0) return false;
        // Make sure at least one friend has devices
        return friends.some(f => f.devices && f.devices.length > 0);
      },
      { timeout: 10000 }
    );
    const bob2FriendInfo = await bob2Page.evaluate(() => {
      const friends = window.__client.friends.getAll();
      return friends.map(f => ({ username: f.username, deviceCount: f.devices?.length || 0, status: f.status }));
    });
    console.log('Bob2 friends synced:', JSON.stringify(bob2FriendInfo));

    // ============================================================
    // SCENARIO 7: Device Revocation
    // ============================================================
    console.log('\n=== SCENARIO 7: Device Revocation ===');

    // --- 7.1: Send messages from all three perspectives ---
    console.log('--- 7.1: Exchange messages ---');

    // Navigate everyone to chat pages
    await bobPage.goto(`/messages/${username}`);
    await bobPage.waitForSelector('#message-text');
    await bob2Page.goto(`/messages/${username}`);
    await bob2Page.waitForSelector('#message-text');
    await page.goto(`/messages/${bobUsername}`);
    await page.waitForSelector('#message-text');

    // Alice sends message
    await page.fill('#message-text', 'Hello from Alice!');
    await page.click('button[type="submit"]');
    await delay(500);
    console.log('Alice sent message');

    // Bob1 sends message
    await bobPage.fill('#message-text', 'Hello from Bob1!');
    await bobPage.click('button[type="submit"]');
    await delay(500);
    console.log('Bob1 sent message');

    // Bob2 sends message (this should disappear after revocation)
    await bob2Page.fill('#message-text', 'Hello from Bob2!');
    await bob2Page.click('button[type="submit"]');
    await delay(500);
    console.log('Bob2 sent message');

    // Wait for messages to propagate
    await delay(1000);

    // Verify all messages are visible to Alice
    await page.goto(`/messages/${bobUsername}`);
    await page.waitForSelector('.message', { timeout: 15000 });
    let aliceMessages = await page.$$eval('.message .text', els => els.map(e => e.textContent));
    expect(aliceMessages).toContain('Hello from Alice!');
    expect(aliceMessages).toContain('Hello from Bob1!');
    expect(aliceMessages).toContain('Hello from Bob2!');
    console.log('Alice sees all 3 messages');

    // --- 7.2: Bob1 revokes Bob2 ---
    console.log('--- 7.2: Revoke Bob2 ---');

    // Get bob2's serverUserId
    const bob2ServerUserId = await bob2Page.evaluate(() => window.__client.userId);
    console.log('Bob2 serverUserId:', bob2ServerUserId.slice(0, 8) + '...');

    // Set up listener for Alice to receive device announce
    const aliceRevokeAnnouncePromise = page.waitForEvent('console', {
      predicate: msg => msg.text().includes('[Global] Device announce: revocation'),
      timeout: 15000,
    });

    // Bob1 revokes bob2 using recovery phrase via UI
    await bobPage.goto(`/devices/revoke/${bob2ServerUserId}`);
    await bobPage.waitForSelector('.phrase-grid', { timeout: 10000 });

    // Verify 12 input boxes exist
    const phraseInputs = await bobPage.$$('.phrase-word');
    expect(phraseInputs.length).toBe(12);
    console.log('12 phrase input boxes rendered');

    // Fill each input with one word
    const phraseWords = bobSavedPhrase.split(' ');
    for (let i = 0; i < 12; i++) {
      await phraseInputs[i].fill(phraseWords[i]);
    }

    // Submit the form
    await bobPage.click('button[type="submit"]');
    await bobPage.waitForSelector('.success', { timeout: 15000 });
    console.log('Bob1 revoked Bob2 via UI');

    // --- 7.3: Verify everyone is notified ---
    console.log('--- 7.3: Verify notifications ---');

    // Alice should receive device announce with revocation
    await aliceRevokeAnnouncePromise;
    console.log('Alice received revocation announce');

    // --- 7.5: Verify Bob2 self-bricks ---
    console.log('--- 7.5: Verify Bob2 self-bricks ---');

    // Bob2 should receive the revocation and be redirected to login
    // The deviceRevoked event triggers data wipe and redirect
    await bob2Page.waitForURL('**/login', { timeout: 15000 });
    console.log('Bob2 redirected to login page (self-bricked)');

    // Verify Bob2's data was wiped - check localStorage and IndexedDB
    const bob2DataWiped = await bob2Page.evaluate(async () => {
      // Check localStorage session is gone
      const session = localStorage.getItem('obscura_session');
      if (session) {
        return { wiped: false, reason: 'localStorage session still exists' };
      }

      // Check that Signal keys database is deleted or empty
      // The database name format is: obscura_signal_v2_{username}
      const databases = await indexedDB.databases();
      const signalDbs = databases.filter(db => db.name?.startsWith('obscura_signal_v2_'));

      // If any Signal DB exists for this user, check if it has keys
      for (const db of signalDbs) {
        try {
          const openReq = indexedDB.open(db.name);
          const hasKeys = await new Promise((resolve) => {
            openReq.onsuccess = () => {
              const idb = openReq.result;
              // Check if identityKey store has data
              if (!idb.objectStoreNames.contains('identityKey')) {
                idb.close();
                resolve(false);
                return;
              }
              const tx = idb.transaction('identityKey', 'readonly');
              const store = tx.objectStore('identityKey');
              const countReq = store.count();
              countReq.onsuccess = () => {
                idb.close();
                resolve(countReq.result > 0);
              };
              countReq.onerror = () => {
                idb.close();
                resolve(false);
              };
            };
            openReq.onerror = () => resolve(false);
          });
          if (hasKeys) {
            return { wiped: false, reason: `Signal DB ${db.name} still has keys` };
          }
        } catch (e) {
          // DB access failed, that's fine
        }
      }

      return { wiped: true };
    });
    console.log('Bob2 data wipe check:', JSON.stringify(bob2DataWiped));
    expect(bob2DataWiped.wiped).toBe(true);
    console.log('Bob2 data wiped (session and keys)');

    await delay(500);

    // Alice should now see only 1 Bob device (bob1)
    const aliceViewAfterRevoke = await page.evaluate((bUsername) => {
      const friend = window.__client.friends.get(bUsername);
      return friend?.devices?.length || 0;
    }, bobUsername);
    expect(aliceViewAfterRevoke).toBe(1);
    console.log('Alice sees 1 Bob device after revocation');

    // Bob1 should have 0 other devices
    const bob1Devices = await bobPage.evaluate(() => window.__client.devices.getAll().length);
    expect(bob1Devices).toBe(0);
    console.log('Bob1 has 0 other devices after revocation');

    // --- 7.4: Verify Bob2's messages disappear ---
    console.log('--- 7.4: Verify messages disappear ---');

    // Alice checks messages - Bob2's message should be gone
    await page.goto(`/messages/${bobUsername}`);
    await page.waitForSelector('.message', { timeout: 15000 });
    aliceMessages = await page.$$eval('.message .text', els => els.map(e => e.textContent));

    expect(aliceMessages).toContain('Hello from Alice!');
    expect(aliceMessages).toContain('Hello from Bob1!');
    expect(aliceMessages).not.toContain('Hello from Bob2!');
    console.log('Alice no longer sees Bob2 message');

    // Bob1 checks messages - Bob2's message should be gone (self-sync deletion)
    await bobPage.goto(`/messages/${username}`);
    await bobPage.waitForSelector('.message', { timeout: 15000 });
    const bob1Messages = await bobPage.$$eval('.message .text', els => els.map(e => e.textContent));

    expect(bob1Messages).toContain('Hello from Alice!');
    expect(bob1Messages).toContain('Hello from Bob1!');
    expect(bob1Messages).not.toContain('Hello from Bob2!');
    console.log('Bob1 no longer sees Bob2 message');

    console.log('\n=== SCENARIO 7 COMPLETE ===\n');

    // ============================================================
    // CLEANUP
    // ============================================================
    await bob2Context.close();
    await aliceContext.close();
    await bobContext.close();
  });

});
