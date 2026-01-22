import { test, expect } from '@playwright/test';

/**
 * SESSION RESET TEST
 *
 * This test demonstrates the "friend desync" problem:
 * 1. Alice and Bob become friends and exchange messages (session established)
 * 2. Alice clears her browser data (loses IndexedDB - keys, sessions, friend list)
 * 3. Alice logs back in (generates NEW identity keys)
 * 4. Bob still has Alice in his friend list with OLD session/keys
 * 5. Bob sends a message -> Alice can't decrypt (wrong keys)
 * 6. Alice doesn't even know Bob exists (friend list was cleared)
 *
 * This test will FAIL until we implement a session reset protocol.
 */

function randomUsername() {
  return 'test_' + Math.random().toString(36).substring(2, 12);
}

async function registerUser(page, username) {
  await page.goto('/');
  await page.click('#toggle-mode');
  await page.fill('#username', username);
  await page.fill('#password', 'testpass123');
  await page.click('.auth-btn');
  await page.waitForSelector('.app-container', { timeout: 30000 });
}

async function loginUser(page, username) {
  await page.goto('/');
  await page.fill('#username', username);
  await page.fill('#password', 'testpass123');
  await page.click('.auth-btn');
  await page.waitForSelector('.app-container', { timeout: 30000 });
}

async function getUserId(page) {
  await page.click('.nav-btn[data-tab="profile"]');
  await page.waitForSelector('#user-id-display');
  return (await page.textContent('#user-id-display')).trim();
}

async function getIdentityKey(page) {
  return await page.evaluate(async () => {
    const db = await new Promise((resolve, reject) => {
      const request = indexedDB.open('obscura_signal_store', 1);
      request.onerror = () => reject(request.error);
      request.onsuccess = () => resolve(request.result);
    });

    const tx = db.transaction('identityKeys', 'readonly');
    const store = tx.objectStore('identityKeys');
    const keyPair = await new Promise((resolve, reject) => {
      const request = store.get('local');
      request.onerror = () => reject(request.error);
      request.onsuccess = () => resolve(request.result);
    });

    db.close();

    if (!keyPair) return null;
    // Return hex string of public key for easy comparison
    return Array.from(new Uint8Array(keyPair.pubKey))
      .map(b => b.toString(16).padStart(2, '0'))
      .join('');
  });
}

async function sendFriendRequest(page, targetUserId) {
  await page.click('.nav-btn[data-tab="profile"]');
  await page.waitForSelector('#friend-id-input');
  await page.fill('#friend-id-input', targetUserId);
  await page.click('#add-friend-btn');
  await page.waitForTimeout(2000);
}

async function acceptFriendRequest(page) {
  await page.click('.nav-btn[data-tab="inbox"]');
  await expect(page.locator('.friend-request-card')).toBeVisible({ timeout: 15000 });
  await page.locator('.request-btn.accept').first().click();
  await page.waitForTimeout(1000);
}

async function sendTestMessage(page, targetUserId, text = 'Test message') {
  await page.evaluate(async ({ targetUserId, text }) => {
    const gateway = window.__gateway;
    const client = window.__client;
    const sessionManager = window.__sessionManager;

    await gateway.loadProto();

    const clientMessageBytes = gateway.encodeClientMessage({
      type: 'TEXT',
      text: text,
    });

    const encrypted = await sessionManager.encrypt(targetUserId, clientMessageBytes);
    const protobufData = gateway.encodeOutgoingMessage(encrypted.body, encrypted.protoType);
    await client.sendMessage(targetUserId, protobufData);
  }, { targetUserId, text });
}

async function clearAllIndexedDB(page) {
  // Clear all IndexedDB databases to simulate "clear browser data"
  await page.evaluate(async () => {
    const databases = await indexedDB.databases();
    for (const db of databases) {
      if (db.name) {
        indexedDB.deleteDatabase(db.name);
      }
    }
    // Also clear localStorage
    localStorage.clear();
  });
}

async function hasFriend(page, friendUserId) {
  return await page.evaluate(async (friendUserId) => {
    try {
      const db = await new Promise((resolve, reject) => {
        const request = indexedDB.open('obscura_friends', 1);
        request.onerror = () => reject(request.error);
        request.onsuccess = () => resolve(request.result);
      });

      const tx = db.transaction('friends', 'readonly');
      const store = tx.objectStore('friends');
      const friend = await new Promise((resolve, reject) => {
        const request = store.get(friendUserId);
        request.onerror = () => reject(request.error);
        request.onsuccess = () => resolve(request.result);
      });

      db.close();
      return friend !== undefined;
    } catch {
      return false;
    }
  }, friendUserId);
}

async function waitForMessageReceived(page, timeout = 15000) {
  // Wait for the message viewer to appear (indicating message was decrypted and displayed)
  try {
    await expect(page.locator('.message-viewer')).toBeVisible({ timeout });
    return true;
  } catch {
    return false;
  }
}

async function checkForDecryptionError(page) {
  // Check console logs for decryption errors
  const errors = [];
  page.on('console', msg => {
    const text = msg.text();
    if (text.includes('decrypt') || text.includes('session') || text.includes('identity')) {
      errors.push(text);
    }
  });
  return errors;
}

test.describe('Session Reset Protocol', () => {

  test('FAILING: Message fails after recipient clears IndexedDB (demonstrates the problem)', async ({ browser }) => {
    test.setTimeout(120000); // 2 minutes

    // Create two browser contexts
    const contextAlice = await browser.newContext();
    const contextBob = await browser.newContext();
    const pageAlice = await contextAlice.newPage();
    const pageBob = await contextBob.newPage();

    // Handle dialogs
    pageAlice.on('dialog', d => d.accept());
    pageBob.on('dialog', d => d.accept());

    // Collect console logs for debugging
    const aliceLogs = [];
    const bobLogs = [];
    pageAlice.on('console', msg => {
      const text = msg.text();
      aliceLogs.push(text);
      if (text.includes('decrypt') || text.includes('session') || text.includes('identity') || text.includes('error') || text.includes('Error')) {
        console.log('[Alice]', text);
      }
    });
    pageBob.on('console', msg => {
      const text = msg.text();
      bobLogs.push(text);
      if (text.includes('decrypt') || text.includes('session') || text.includes('identity') || text.includes('error') || text.includes('Error')) {
        console.log('[Bob]', text);
      }
    });

    const usernameAlice = randomUsername();
    const usernameBob = randomUsername();

    console.log('=== PHASE 1: Setup - Register users and become friends ===');

    // Register both users
    await registerUser(pageAlice, usernameAlice);
    const aliceId = await getUserId(pageAlice);
    const aliceKeyBefore = await getIdentityKey(pageAlice);
    console.log('Alice registered:', aliceId);
    console.log('Alice identity key (first 16 chars):', aliceKeyBefore?.substring(0, 16));

    await registerUser(pageBob, usernameBob);
    const bobId = await getUserId(pageBob);
    console.log('Bob registered:', bobId);

    // Bob sends friend request to Alice
    console.log('Bob sending friend request to Alice...');
    await sendFriendRequest(pageBob, aliceId);

    // Alice accepts
    console.log('Alice accepting friend request...');
    await acceptFriendRequest(pageAlice);

    // Wait for friendship to sync
    await pageAlice.waitForTimeout(3000);
    await pageBob.waitForTimeout(3000);

    console.log('=== PHASE 2: Verify initial messaging works ===');

    // Bob sends a message to Alice (establishes session)
    console.log('Bob sending test message to Alice...');
    await sendTestMessage(pageBob, aliceId, 'Hello Alice! This is the first message.');

    // Alice should receive it
    await pageAlice.click('.nav-btn[data-tab="inbox"]');
    await pageAlice.waitForTimeout(2000);

    // Check for unread indicator from Bob
    const hasUnread = await pageAlice.locator(`.friend-item[data-userid="${bobId}"] .message-indicator.unread`).count();
    console.log('Alice has unread from Bob:', hasUnread > 0 ? 'YES' : 'NO');
    expect(hasUnread).toBeGreaterThan(0);

    // View the message
    await pageAlice.locator(`.friend-item[data-userid="${bobId}"]`).click();
    const firstMessageReceived = await waitForMessageReceived(pageAlice, 10000);
    expect(firstMessageReceived).toBe(true);
    console.log('First message received successfully!');
    await pageAlice.waitForTimeout(4000); // Let message auto-close

    console.log('=== PHASE 3: Alice clears browser data (simulating cache clear) ===');

    // Alice logs out first
    await pageAlice.click('.nav-btn[data-tab="profile"]');
    await pageAlice.click('#logout');
    await pageAlice.waitForSelector('#auth-form', { timeout: 10000 });
    console.log('Alice logged out');

    // Clear ALL IndexedDB (simulating "Clear browsing data")
    await clearAllIndexedDB(pageAlice);
    console.log('Alice IndexedDB cleared!');

    console.log('=== PHASE 4: Alice logs back in (will regenerate keys) ===');

    // Alice logs back in - this will generate NEW identity keys
    await loginUser(pageAlice, usernameAlice);
    console.log('Alice logged back in');

    // Verify Alice has NEW identity key
    const aliceKeyAfter = await getIdentityKey(pageAlice);
    console.log('Alice identity key AFTER (first 16 chars):', aliceKeyAfter?.substring(0, 16));

    // Keys should be DIFFERENT (this is the root of the problem)
    expect(aliceKeyAfter).not.toBe(aliceKeyBefore);
    console.log('CONFIRMED: Alice has NEW identity key (different from before)');

    // Verify Alice does NOT have Bob in her friend list anymore
    const aliceHasBob = await hasFriend(pageAlice, bobId);
    console.log('Alice has Bob in friend list:', aliceHasBob ? 'YES' : 'NO');
    expect(aliceHasBob).toBe(false);
    console.log('CONFIRMED: Alice lost Bob from friend list');

    console.log('=== PHASE 5: Bob sends message to Alice (THE PROBLEM) ===');
    console.log('Bob still has Alice in his friend list with OLD session/keys');
    console.log('Bob will try to send a message using the OLD session...');

    // Bob sends a message using his OLD session with Alice's OLD keys
    await sendTestMessage(pageBob, aliceId, 'Hello Alice! Are you there?');
    console.log('Bob sent message to Alice');

    // Wait for message delivery
    await pageAlice.waitForTimeout(5000);

    // Check Alice's inbox
    await pageAlice.click('.nav-btn[data-tab="inbox"]');
    await pageAlice.waitForTimeout(2000);

    // THE CRITICAL CHECKS:

    // 1. Alice shouldn't even see Bob in her friend list (she lost it)
    const bobInAliceList = await pageAlice.locator(`.friend-item[data-userid="${bobId}"]`).count();
    console.log('Bob appears in Alice friend list:', bobInAliceList > 0 ? 'YES' : 'NO');

    // 2. Even if the message arrived, Alice can't decrypt it (wrong keys)
    // Check for decryption errors in logs
    const decryptErrors = aliceLogs.filter(log =>
      log.toLowerCase().includes('decrypt') && log.toLowerCase().includes('error') ||
      log.toLowerCase().includes('bad mac') ||
      log.toLowerCase().includes('invalid') ||
      log.toLowerCase().includes('failed')
    );
    console.log('Decryption errors found:', decryptErrors.length);
    if (decryptErrors.length > 0) {
      console.log('Error samples:', decryptErrors.slice(0, 3));
    }

    console.log('\n=== EXPECTED BEHAVIOR (with session reset protocol) ===');
    console.log('1. Bob sends message with old session');
    console.log('2. Alice detects identity key mismatch or decryption failure');
    console.log('3. Alice sends SESSION_RESET message to Bob');
    console.log('4. Bob receives reset, fetches Alice NEW PreKeyBundle');
    console.log('5. Bob re-establishes session with new keys');
    console.log('6. Bob re-sends the message with new session');
    console.log('7. Alice receives and decrypts successfully');
    console.log('8. Both users are re-synced as friends');

    // THIS IS WHAT SHOULD PASS AFTER WE IMPLEMENT SESSION RESET:
    // For now, this assertion will FAIL - demonstrating the problem

    console.log('\n=== ASSERTION: Bob should be able to message Alice after her key reset ===');
    console.log('(This WILL FAIL until session reset protocol is implemented)');

    // The test: After session reset protocol, Alice should have Bob back
    // and the message should have been received
    const finalBobInList = await pageAlice.locator(`.friend-item[data-userid="${bobId}"]`).count();

    // This assertion demonstrates the problem - it will FAIL
    // After implementing session reset, this should PASS
    expect(finalBobInList).toBeGreaterThan(0); // WILL FAIL - that's the point!

    await contextAlice.close();
    await contextBob.close();
  });

  test('FAILING: Bidirectional desync - both users lose each other', async ({ browser }) => {
    test.setTimeout(120000);

    // This test shows the worst case: both users have the other in their list
    // but sessions are broken in BOTH directions

    const contextAlice = await browser.newContext();
    const contextBob = await browser.newContext();
    const pageAlice = await contextAlice.newPage();
    const pageBob = await contextBob.newPage();

    pageAlice.on('dialog', d => d.accept());
    pageBob.on('dialog', d => d.accept());

    const usernameAlice = randomUsername();
    const usernameBob = randomUsername();

    console.log('=== Setup: Create friends ===');
    await registerUser(pageAlice, usernameAlice);
    const aliceId = await getUserId(pageAlice);

    await registerUser(pageBob, usernameBob);
    const bobId = await getUserId(pageBob);

    // Become friends
    await sendFriendRequest(pageBob, aliceId);
    await acceptFriendRequest(pageAlice);
    await pageAlice.waitForTimeout(3000);

    // Exchange messages to establish sessions
    console.log('Establishing sessions with bidirectional messages...');
    await sendTestMessage(pageBob, aliceId, 'Hi Alice');
    await pageAlice.waitForTimeout(2000);
    await sendTestMessage(pageAlice, bobId, 'Hi Bob');
    await pageBob.waitForTimeout(2000);
    console.log('Sessions established');

    console.log('=== Alice clears data ===');
    await pageAlice.click('.nav-btn[data-tab="profile"]');
    await pageAlice.click('#logout');
    await pageAlice.waitForSelector('#auth-form', { timeout: 10000 });
    await clearAllIndexedDB(pageAlice);
    await loginUser(pageAlice, usernameAlice);

    console.log('=== Current state ===');
    console.log('- Alice: NEW keys, NO friends, NO sessions');
    console.log('- Bob: OLD keys for Alice, HAS Alice in friends, HAS old session');

    // Bob tries to message Alice
    console.log('Bob messaging Alice (will fail - wrong keys)...');
    await sendTestMessage(pageBob, aliceId, 'Alice are you there?');
    await pageAlice.waitForTimeout(3000);

    // Alice tries to message Bob (she doesn't even know Bob exists!)
    console.log('Alice trying to message Bob (she doesn\'t know him)...');

    // Alice has no session with Bob, would need to establish new one
    // But she doesn't have Bob in her friend list!
    const aliceHasBobNow = await hasFriend(pageAlice, bobId);
    console.log('Alice has Bob:', aliceHasBobNow);

    // WITH session reset protocol, this scenario should auto-recover:
    // 1. Bob's message fails to decrypt on Alice's side
    // 2. Alice detects unknown sender or decryption failure
    // 3. Protocol initiates session reset
    // 4. Both users re-establish sessions and friend relationship

    // This should pass after implementation:
    expect(aliceHasBobNow).toBe(true); // WILL FAIL - demonstrating the problem

    await contextAlice.close();
    await contextBob.close();
  });

});
