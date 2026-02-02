/**
 * E2E Scenario 14 - Multi-Device Message Migration
 *
 * Tests that messages sent from a new device BEFORE the DEVICE_ANNOUNCE
 * reaches the recipient are correctly migrated once the announce arrives.
 *
 * This tests the race condition fix where:
 * 1. Alice Device2 sends to Bob before Bob knows about Device2
 * 2. Message is stored under serverUserId (wrong conversationId)
 * 3. DEVICE_ANNOUNCE arrives, message is migrated to Alice's username
 * 4. Bob sees the message in Alice's conversation
 *
 * Setup: Alice (2 devices) and Bob (1 device) are friends
 */
import { test, expect } from '@playwright/test';
import { delay, randomUsername, waitForViewReady } from './helpers.js';

test.describe('Scenario 14: Multi-Device Message Migration', () => {

  test('Message from new device migrates after DEVICE_ANNOUNCE', async ({ browser }) => {
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
    // SETUP: Register Alice1 and Bob
    // ============================================================
    console.log('\n=== SETUP: Register Alice1 ===');
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

    // Get Bob's userId for befriend call
    const bobUserId = await bobPage.evaluate(() => window.__client.userId);

    // ============================================================
    // SETUP: Alice1 and Bob become friends
    // ============================================================
    console.log('\n=== SETUP: Alice1 and Bob become friends ===');

    // Alice sends friend request to Bob
    await alice1Page.evaluate(async ({ userId, username }) => {
      await window.__client.befriend(userId, username);
    }, { userId: bobUserId, username: bobUsername });
    console.log('Alice sent friend request to Bob');

    // Wait for Bob to receive the request
    await delay(1000);

    // Bob accepts the friend request via UI
    await bobPage.goto('/friends');
    await bobPage.waitForSelector('.friend-item.pending', { timeout: 15000 });
    await bobPage.click(`.accept-btn[data-username="${aliceUsername}"]`);
    console.log('Bob accepted friend request');

    await delay(1000);

    // Verify friendship
    const aliceHasBob = await alice1Page.evaluate((username) => {
      return window.__client.friends.getAll().some(f => f.username === username);
    }, bobUsername);
    expect(aliceHasBob).toBe(true);
    console.log('Alice and Bob are now friends');

    // ============================================================
    // SETUP: Link Alice2 (but DON'T announce yet)
    // ============================================================
    console.log('\n=== SETUP: Link Alice2 ===');

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

    // Alice1 approves Alice2 but does NOT call announceDevices() yet
    await alice1Page.evaluate(async (code) => {
      await window.__client.approveLink(code);
      // Intentionally NOT calling announceDevices() here
    }, alice2LinkCode);

    await alice2Page.waitForURL('**/stories', { timeout: 20000 });

    let alice2Ws = false;
    for (let i = 0; i < 10; i++) {
      await delay(500);
      alice2Ws = await alice2Page.evaluate(() => window.__client?.ws?.readyState === 1);
      if (alice2Ws) break;
    }
    expect(alice2Ws).toBe(true);
    console.log('Alice2 linked and connected (but Bob does NOT know about Alice2 yet)');

    // ============================================================
    // SCENARIO 14.1: Alice2 sends message to Bob BEFORE announce
    // ============================================================
    console.log('\n=== 14.1: Alice2 sends message BEFORE DEVICE_ANNOUNCE ===');

    const testMessage = 'Hello from Alice Device 2! ' + Date.now();

    // Get Alice2's serverUserId for later verification
    const alice2UserId = await alice2Page.evaluate(() => window.__client.userId);
    console.log('Alice2 userId:', alice2UserId.slice(-8));

    // Verify Bob does NOT have Alice2 in Alice's device list yet
    const bobKnowsAlice2Before = await bobPage.evaluate((alice2Id) => {
      const alice = window.__client.friends.getAll()[0];
      if (!alice) return false;
      return alice.devices.some(d => d.serverUserId === alice2Id);
    }, alice2UserId);
    expect(bobKnowsAlice2Before).toBe(false);
    console.log('Confirmed: Bob does NOT know about Alice2 yet');

    // Alice2 sends message to Bob
    await alice2Page.evaluate(async ({ username, message }) => {
      await window.__client.send(username, { text: message });
    }, { username: bobUsername, message: testMessage });
    console.log('Alice2 sent message to Bob');

    // Wait for message to arrive at Bob
    await delay(2000);

    // Check if message is stored under wrong conversationId (Alice2's serverUserId)
    const messageUnderWrongId = await bobPage.evaluate(async ({ alice2Id, expectedText }) => {
      const messages = await window.__client.getMessages(alice2Id);
      return messages.some(m => m.content === expectedText || m.text === expectedText);
    }, { alice2Id: alice2UserId, expectedText: testMessage });

    // Check if message is under correct conversationId (alice's username)
    const messageUnderCorrectId = await bobPage.evaluate(async ({ aliceUsername, expectedText }) => {
      const messages = await window.__client.getMessages(aliceUsername);
      return messages.some(m => m.content === expectedText || m.text === expectedText);
    }, { aliceUsername, expectedText: testMessage });

    console.log(`Message under wrong ID (${alice2UserId.slice(-8)}): ${messageUnderWrongId}`);
    console.log(`Message under correct ID (${aliceUsername}): ${messageUnderCorrectId}`);

    // At this point, message should be under wrong ID (or possibly correct if timing worked out)
    // The key test is what happens after announce

    // ============================================================
    // SCENARIO 14.2: Alice1 announces devices, message should migrate
    // ============================================================
    console.log('\n=== 14.2: Alice1 announces devices ===');

    // Set up listener for migration event on Bob's side
    const migrationPromise = bobPage.evaluate(() => {
      return new Promise((resolve) => {
        const handler = (event) => {
          window.__client.off('messagesMigrated', handler);
          resolve(event);
        };
        window.__client.on('messagesMigrated', handler);
        // Timeout after 10 seconds
        setTimeout(() => resolve(null), 10000);
      });
    });

    // Alice1 announces devices
    await alice1Page.evaluate(async () => {
      await window.__client.announceDevices();
    });
    console.log('Alice1 announced devices');

    // Wait for Bob to receive the announce and potentially migrate messages
    await delay(3000);

    // Check migration event
    const migrationEvent = await migrationPromise;
    if (migrationEvent) {
      console.log(`Migration event received: ${migrationEvent.count} messages migrated to ${migrationEvent.conversationId}`);
    } else {
      console.log('No migration event (message may have been correctly routed initially)');
    }

    // ============================================================
    // SCENARIO 14.3: Verify message is now under correct conversationId
    // ============================================================
    console.log('\n=== 14.3: Verify message is under correct conversationId ===');

    // Verify Bob now knows about Alice2
    const bobKnowsAlice2After = await bobPage.evaluate((alice2Id) => {
      const alice = window.__client.friends.getAll()[0];
      if (!alice) return false;
      return alice.devices.some(d => d.serverUserId === alice2Id);
    }, alice2UserId);
    expect(bobKnowsAlice2After).toBe(true);
    console.log('Bob now knows about Alice2');

    // Verify message is under Alice's username
    const messageFoundCorrectly = await bobPage.evaluate(async ({ aliceUsername, expectedText }) => {
      const messages = await window.__client.getMessages(aliceUsername);
      return messages.some(m => m.content === expectedText || m.text === expectedText);
    }, { aliceUsername, expectedText: testMessage });
    expect(messageFoundCorrectly).toBe(true);
    console.log('Message is now under correct conversationId (Alice username)');

    // Verify message is NOT under Alice2's serverUserId anymore
    const messageStillUnderWrongId = await bobPage.evaluate(async ({ alice2Id, expectedText }) => {
      const messages = await window.__client.getMessages(alice2Id);
      return messages.some(m => m.content === expectedText || m.text === expectedText);
    }, { alice2Id: alice2UserId, expectedText: testMessage });
    expect(messageStillUnderWrongId).toBe(false);
    console.log('Message is NOT under wrong conversationId anymore');

    console.log('\n=== SCENARIO 14 COMPLETE ===\n');

    // ============================================================
    // CLEANUP
    // ============================================================
    await alice1Context.close();
    await alice2Context.close();
    await bobContext.close();
  });

});
