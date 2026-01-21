import { test, expect } from '@playwright/test';

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

async function getUserId(page) {
  await page.click('.nav-btn[data-tab="profile"]');
  await page.waitForSelector('#user-id-display');
  return (await page.textContent('#user-id-display')).trim();
}

async function sendFriendRequest(page, targetUserId) {
  await page.click('.nav-btn[data-tab="profile"]');
  await page.waitForSelector('#friend-id-input');
  await page.fill('#friend-id-input', targetUserId);
  await page.click('#add-friend-btn');
  await page.waitForTimeout(2000);
}

async function acceptAllFriendRequests(page, expectedCount) {
  await page.click('.nav-btn[data-tab="inbox"]');
  await expect(page.locator('.friend-request-card')).toHaveCount(expectedCount, { timeout: 15000 });

  for (let i = 0; i < expectedCount; i++) {
    await page.locator('.request-btn.accept').first().click();
    await page.waitForTimeout(1000);
  }
}

async function sendTestMessage(page, targetUserId, text = 'Test message') {
  await page.evaluate(async ({ targetUserId, text }) => {
    const gateway = window.__gateway;
    const client = window.__client;
    const sessionManager = window.__sessionManager;

    await gateway.loadProto();

    // Create a 1x1 black pixel JPEG
    const canvas = document.createElement('canvas');
    canvas.width = 1;
    canvas.height = 1;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = 'black';
    ctx.fillRect(0, 0, 1, 1);

    const blob = await new Promise(r => canvas.toBlob(r, 'image/jpeg', 0.8));
    const arrayBuffer = await blob.arrayBuffer();
    const imageData = new Uint8Array(arrayBuffer);

    const clientMessageBytes = gateway.encodeClientMessage({
      type: 'IMAGE',
      text: text,
      imageData: imageData,
      mimeType: 'image/jpeg',
      displayDuration: 3,
    });

    const encrypted = await sessionManager.encrypt(targetUserId, clientMessageBytes);
    const protobufData = gateway.encodeOutgoingMessage(encrypted.body, encrypted.protoType);
    await client.sendMessage(targetUserId, protobufData);
  }, { targetUserId, text });
}

test.describe('Persistence', () => {

  test('Signal keys survive page refresh (no regeneration)', async ({ page }) => {
    const username = randomUsername();

    // Go to app
    await page.goto('/');

    // Switch to register mode by clicking the toggle
    await page.click('#toggle-mode');

    // Fill registration form
    await page.fill('#username', username);
    await page.fill('#password', 'testpass123');
    await page.click('.auth-btn');

    // Wait for app to load (loading screen then app container)
    await page.waitForSelector('.app-container', { timeout: 30000 });

    // Collect console logs after refresh
    const consoleLogs = [];
    page.on('console', msg => consoleLogs.push(msg.text()));

    // Refresh page
    await page.reload();

    // Wait for app to load again
    await page.waitForSelector('.app-container', { timeout: 30000 });

    // Wait a moment for any async key checks
    await page.waitForTimeout(2000);

    // Check console - should NOT see "No local keys found, regenerating"
    const regenerationLog = consoleLogs.find(log =>
      log.includes('No local keys found') || log.includes('regenerating')
    );
    expect(regenerationLog).toBeUndefined();
  });

  test('Friend request survives page refresh', async ({ browser }) => {
    // Create two browser contexts (two users)
    const contextA = await browser.newContext();
    const contextB = await browser.newContext();
    const pageA = await contextA.newPage();
    const pageB = await contextB.newPage();

    // Handle dialogs
    pageA.on('dialog', dialog => dialog.accept());
    pageB.on('dialog', dialog => dialog.accept());

    const usernameA = randomUsername();
    const usernameB = randomUsername();

    // Register User A
    await pageA.goto('/');
    await pageA.click('#toggle-mode');
    await pageA.fill('#username', usernameA);
    await pageA.fill('#password', 'testpass123');
    await pageA.click('.auth-btn');
    await pageA.waitForSelector('.app-container', { timeout: 30000 });

    // Get User A's ID from profile
    await pageA.click('.nav-btn[data-tab="profile"]');
    await pageA.waitForSelector('#user-id-display');
    const userAId = await pageA.textContent('#user-id-display');

    // Register User B
    await pageB.goto('/');
    await pageB.click('#toggle-mode');
    await pageB.fill('#username', usernameB);
    await pageB.fill('#password', 'testpass123');
    await pageB.click('.auth-btn');
    await pageB.waitForSelector('.app-container', { timeout: 30000 });

    // User B adds User A as friend
    await pageB.click('.nav-btn[data-tab="profile"]');
    await pageB.waitForSelector('#friend-id-input');
    await pageB.fill('#friend-id-input', userAId.trim());
    await pageB.click('#add-friend-btn');

    // Wait for friend request to be sent
    await pageB.waitForTimeout(3000);

    // User A should see friend request in inbox
    await pageA.click('.nav-btn[data-tab="inbox"]');
    await expect(pageA.locator('.friend-request-card')).toBeVisible({ timeout: 15000 });

    // KEY TEST: Refresh User A's page
    await pageA.reload();
    await pageA.waitForSelector('.app-container', { timeout: 30000 });

    // Go to inbox - friend request should STILL be there
    await pageA.click('.nav-btn[data-tab="inbox"]');
    await expect(pageA.locator('.friend-request-card')).toBeVisible({ timeout: 10000 });

    // Cleanup
    await contextA.close();
    await contextB.close();
  });

  test('Friend request received while logged out appears after login', async ({ browser }) => {
    // This test verifies:
    // 1. User A logs out (keys persist in IndexedDB)
    // 2. User B sends friend request to User A
    // 3. User A logs back in (same keys, can decrypt message)
    // 4. User A should see the friend request

    const contextA = await browser.newContext();
    const contextB = await browser.newContext();
    const pageA = await contextA.newPage();
    const pageB = await contextB.newPage();

    const usernameA = randomUsername();
    const usernameB = randomUsername();

    // Handle dialogs
    pageA.on('dialog', dialog => dialog.accept());
    pageB.on('dialog', dialog => dialog.accept());

    // Debug logging
    pageA.on('console', msg => {
      const text = msg.text();
      if (text.includes('Received') || text.includes('Processing') || text.includes('keys') || text.includes('regenerating')) {
        console.log('[A]', text);
      }
    });

    // Register User A
    await pageA.goto('/');
    await pageA.click('#toggle-mode');
    await pageA.fill('#username', usernameA);
    await pageA.fill('#password', 'testpass123');
    await pageA.click('.auth-btn');
    await pageA.waitForSelector('.app-container', { timeout: 30000 });

    // Get User A's ID
    await pageA.click('.nav-btn[data-tab="profile"]');
    await pageA.waitForSelector('#user-id-display');
    const userAId = await pageA.textContent('#user-id-display');
    console.log('User A ID:', userAId.trim());

    // Register User B
    await pageB.goto('/');
    await pageB.click('#toggle-mode');
    await pageB.fill('#username', usernameB);
    await pageB.fill('#password', 'testpass123');
    await pageB.click('.auth-btn');
    await pageB.waitForSelector('.app-container', { timeout: 30000 });

    // User A logs out (keys should persist!)
    console.log('User A logging out...');
    await pageA.click('.nav-btn[data-tab="profile"]');
    await pageA.waitForSelector('#logout');
    await pageA.click('#logout');
    await pageA.waitForSelector('#auth-form', { timeout: 10000 });
    console.log('User A logged out');

    // User B sends friend request while A is logged out
    await pageB.click('.nav-btn[data-tab="profile"]');
    await pageB.waitForSelector('#friend-id-input');
    await pageB.fill('#friend-id-input', userAId.trim());
    await pageB.click('#add-friend-btn');
    console.log('User B sent friend request to logged-out User A');
    await pageB.waitForTimeout(3000);

    // User A logs back in (should NOT regenerate keys)
    console.log('User A logging back in...');
    await pageA.fill('#username', usernameA);
    await pageA.fill('#password', 'testpass123');
    await pageA.click('.auth-btn');
    await pageA.waitForSelector('.app-container', { timeout: 30000 });
    console.log('User A logged in');

    // Wait for WebSocket to connect and server to deliver queued messages
    await pageA.waitForTimeout(8000);

    // Check inbox
    await pageA.click('.nav-btn[data-tab="inbox"]');

    // Debug: check inbox state
    const inboxHtml = await pageA.locator('.inbox-view').innerHTML();
    console.log('Inbox HTML:', inboxHtml.substring(0, 300));

    // User A should see the friend request (keys persisted, message decryptable)
    await expect(pageA.locator('.friend-request-card')).toBeVisible({ timeout: 15000 });

    await contextA.close();
    await contextB.close();
  });

  test('Friend request appears in real-time without refresh', async ({ browser }) => {
    // Verifies real-time WebSocket delivery - UI updates automatically
    const contextA = await browser.newContext();
    const contextB = await browser.newContext();
    const pageA = await contextA.newPage();
    const pageB = await contextB.newPage();

    pageA.on('dialog', dialog => dialog.accept());
    pageB.on('dialog', dialog => dialog.accept());

    const usernameA = randomUsername();
    const usernameB = randomUsername();

    // Register both users
    await registerUser(pageA, usernameA);
    const userAId = await getUserId(pageA);

    await registerUser(pageB, usernameB);

    // User A navigates to inbox and waits there
    await pageA.click('.nav-btn[data-tab="inbox"]');
    await pageA.waitForSelector('.inbox-view');
    console.log('User A is watching inbox...');

    // Verify inbox is empty initially
    const initialCards = await pageA.locator('.friend-request-card').count();
    expect(initialCards).toBe(0);

    // User B sends friend request (User A is online, watching inbox)
    console.log('User B sending friend request...');
    await sendFriendRequest(pageB, userAId);

    // User A should see it appear in REAL-TIME - no click, no refresh
    console.log('Waiting for real-time delivery...');
    await expect(pageA.locator('.friend-request-card')).toBeVisible({ timeout: 15000 });
    console.log('Friend request appeared in real-time!');

    await contextA.close();
    await contextB.close();
  });

  test('Multiple messages sent while logged out all appear on login', async ({ browser }) => {
    // Verifies server queues ALL messages, not just one
    const contextA = await browser.newContext();
    const contextB = await browser.newContext();
    const contextC = await browser.newContext();
    const pageA = await contextA.newPage();
    const pageB = await contextB.newPage();
    const pageC = await contextC.newPage();

    pageA.on('dialog', dialog => dialog.accept());
    pageB.on('dialog', dialog => dialog.accept());
    pageC.on('dialog', dialog => dialog.accept());

    // Debug logging
    pageA.on('console', msg => {
      const text = msg.text();
      if (text.includes('Received') || text.includes('Processing') || text.includes('keys') || text.includes('regenerating') || text.includes('envelope')) {
        console.log('[A]', text);
      }
    });

    const usernameA = randomUsername();
    const usernameB = randomUsername();
    const usernameC = randomUsername();

    // Register User A
    await registerUser(pageA, usernameA);
    const userAId = await getUserId(pageA);

    // Register User B and C
    await registerUser(pageB, usernameB);
    await registerUser(pageC, usernameC);

    // User A logs out
    console.log('User A logging out...');
    await pageA.click('.nav-btn[data-tab="profile"]');
    await pageA.click('#logout');
    await pageA.waitForSelector('#auth-form', { timeout: 10000 });

    // User B sends friend request while A is logged out
    console.log('User B sending friend request...');
    await sendFriendRequest(pageB, userAId);

    // User C ALSO sends friend request while A is logged out
    console.log('User C sending friend request...');
    await sendFriendRequest(pageC, userAId);

    // Wait for server to process both
    await pageB.waitForTimeout(2000);

    // User A logs back in
    console.log('User A logging back in...');
    await pageA.fill('#username', usernameA);
    await pageA.fill('#password', 'testpass123');
    await pageA.click('.auth-btn');
    await pageA.waitForSelector('.app-container', { timeout: 30000 });

    // Wait for WebSocket to deliver queued messages
    await pageA.waitForTimeout(8000);

    // Check inbox - wait for friend request cards to appear
    await pageA.click('.nav-btn[data-tab="inbox"]');

    // Wait for both friend requests to appear (server delivers them, inbox re-renders)
    await expect(pageA.locator('.friend-request-card')).toHaveCount(2, { timeout: 15000 });

    await contextA.close();
    await contextB.close();
    await contextC.close();
  });

  test('Full mesh - three users exchange friend requests and messages', async ({ browser }) => {
    test.setTimeout(120000); // 2 minutes for this comprehensive test
    // Create contexts with camera permissions granted
    const contextA = await browser.newContext({
      permissions: ['camera'],
    });
    const contextB = await browser.newContext({
      permissions: ['camera'],
    });
    const contextC = await browser.newContext({
      permissions: ['camera'],
    });
    const pageA = await contextA.newPage();
    const pageB = await contextB.newPage();
    const pageC = await contextC.newPage();

    pageA.on('dialog', d => d.accept());
    pageB.on('dialog', d => d.accept());
    pageC.on('dialog', d => d.accept());

    // Debug logging
    pageA.on('console', msg => console.log('[A]', msg.text()));
    pageB.on('console', msg => console.log('[B]', msg.text()));
    pageC.on('console', msg => console.log('[C]', msg.text()));

    const usernameA = randomUsername();
    const usernameB = randomUsername();
    const usernameC = randomUsername();

    console.log('Registering users:', usernameA, usernameB, usernameC);

    // Register all users
    await registerUser(pageA, usernameA);
    await registerUser(pageB, usernameB);
    await registerUser(pageC, usernameC);

    const userAId = await getUserId(pageA);
    const userBId = await getUserId(pageB);
    const userCId = await getUserId(pageC);

    console.log('User IDs:', { A: userAId, B: userBId, C: userCId });

    // Send friend requests to form full mesh
    // Note: App prevents duplicate requests, so we only need:
    // - A sends to B and C (A initiates 2 friendships)
    // - B sends to C (B initiates 1 friendship, already has pending from A)
    // Result: A receives 0 requests, B receives 1 (from A), C receives 2 (from A and B)
    console.log('Sending friend requests...');
    await sendFriendRequest(pageA, userBId);
    console.log('A -> B sent');
    await sendFriendRequest(pageA, userCId);
    console.log('A -> C sent');
    await sendFriendRequest(pageB, userCId);
    console.log('B -> C sent');

    // Wait for delivery
    console.log('Waiting for delivery...');
    await pageA.waitForTimeout(3000);

    // B accepts A's request (B received 1 from A)
    console.log('B accepting friend request from A...');
    await pageB.click('.nav-btn[data-tab="inbox"]');
    await expect(pageB.locator('.friend-request-card')).toHaveCount(1, { timeout: 15000 });
    await pageB.locator('.request-btn.accept').first().click();
    await pageB.waitForTimeout(1000);

    // C accepts both requests (C received 2 from A and B)
    console.log('C accepting friend requests from A and B...');
    await pageC.click('.nav-btn[data-tab="inbox"]');
    await expect(pageC.locator('.friend-request-card')).toHaveCount(2, { timeout: 15000 });
    await pageC.locator('.request-btn.accept').first().click();
    await pageC.waitForTimeout(1000);
    await pageC.locator('.request-btn.accept').first().click();
    await pageC.waitForTimeout(1000);

    // Wait for acceptance messages to propagate
    await pageA.waitForTimeout(2000);

    // Helper to click on a specific friend by their userId
    async function clickOnFriend(page, friendUserId) {
      await page.locator(`.friend-item[data-userid="${friendUserId}"]`).click();
    }

    // Helper to view message from specific friend
    async function viewMessageFrom(page, friendUserId, senderName) {
      await page.click('.nav-btn[data-tab="inbox"]');
      await page.waitForTimeout(1000);

      // Check for unread indicator
      const unreadCount = await page.locator(`.friend-item[data-userid="${friendUserId}"] .message-indicator.unread`).count();
      console.log(`${senderName} has unread indicator:`, unreadCount === 1 ? 'YES' : 'NO');
      expect(unreadCount).toBe(1);

      // Click on the specific friend
      await clickOnFriend(page, friendUserId);

      // Message viewer should appear
      await expect(page.locator('.message-viewer')).toBeVisible({ timeout: 10000 });
      console.log(`Message viewer appeared from ${senderName}!`);

      // Wait for message to auto-close (3 seconds set in sendTestMessage)
      await page.waitForTimeout(3500);
    }

    // FULL MESH MESSAGE TEST: Every user sends to every other user
    console.log('=== FULL MESH MESSAGE TEST ===');

    // A -> B
    console.log('A sending to B...');
    await sendTestMessage(pageA, userBId, 'Hello B from A!');
    await pageB.waitForTimeout(1500);
    await viewMessageFrom(pageB, userAId, 'A');

    // A -> C
    console.log('A sending to C...');
    await sendTestMessage(pageA, userCId, 'Hello C from A!');
    await pageC.waitForTimeout(1500);
    await viewMessageFrom(pageC, userAId, 'A');

    // B -> A
    console.log('B sending to A...');
    await sendTestMessage(pageB, userAId, 'Hello A from B!');
    await pageA.waitForTimeout(1500);
    await viewMessageFrom(pageA, userBId, 'B');

    // B -> C
    console.log('B sending to C...');
    await sendTestMessage(pageB, userCId, 'Hello C from B!');
    await pageC.waitForTimeout(1500);
    await viewMessageFrom(pageC, userBId, 'B');

    // C -> A
    console.log('C sending to A...');
    await sendTestMessage(pageC, userAId, 'Hello A from C!');
    await pageA.waitForTimeout(1500);
    await viewMessageFrom(pageA, userCId, 'C');

    // C -> B
    console.log('C sending to B...');
    await sendTestMessage(pageC, userBId, 'Hello B from C!');
    await pageB.waitForTimeout(1500);
    await viewMessageFrom(pageB, userCId, 'C');

    console.log('=== ALL 6 LIVE MESSAGES RECEIVED AND VIEWED! ===');

    // === OFFLINE SCENARIO TEST ===
    // Test that messages sent while logged out are received on login
    console.log('\n=== OFFLINE MESSAGE TEST ===');

    // B and C log out
    console.log('B and C logging out...');
    await pageB.click('.nav-btn[data-tab="profile"]');
    await pageB.click('#logout');
    await pageB.waitForSelector('#auth-form', { timeout: 10000 });

    await pageC.click('.nav-btn[data-tab="profile"]');
    await pageC.click('#logout');
    await pageC.waitForSelector('#auth-form', { timeout: 10000 });
    console.log('B and C logged out');

    // A sends messages to logged-out B and C
    console.log('A sending messages to offline B and C...');
    await sendTestMessage(pageA, userBId, 'Offline message to B from A!');
    await sendTestMessage(pageA, userCId, 'Offline message to C from A!');
    console.log('Messages sent to offline users');

    // A logs out
    console.log('A logging out...');
    await pageA.click('.nav-btn[data-tab="profile"]');
    await pageA.click('#logout');
    await pageA.waitForSelector('#auth-form', { timeout: 10000 });
    console.log('A logged out');

    // B logs back in and should see the message
    console.log('B logging back in...');
    await pageB.fill('#username', usernameB);
    await pageB.fill('#password', 'testpass123');
    await pageB.click('.auth-btn');
    await pageB.waitForSelector('.app-container', { timeout: 30000 });
    console.log('B logged in');

    // Wait for WebSocket to connect and deliver queued messages
    await pageB.waitForTimeout(5000);

    // B should have an unread message from A
    console.log('B checking for offline message from A...');
    await pageB.click('.nav-btn[data-tab="inbox"]');
    await pageB.waitForTimeout(1000);

    const bOfflineUnread = await pageB.locator(`.friend-item[data-userid="${userAId}"] .message-indicator.unread`).count();
    console.log('B has offline unread from A:', bOfflineUnread === 1 ? 'YES' : 'NO');
    expect(bOfflineUnread).toBe(1);

    // B views the offline message
    await pageB.locator(`.friend-item[data-userid="${userAId}"]`).click();
    await expect(pageB.locator('.message-viewer')).toBeVisible({ timeout: 10000 });
    console.log('B viewed offline message from A!');
    await pageB.waitForTimeout(3500);

    // C logs back in and should see the message
    console.log('C logging back in...');
    await pageC.fill('#username', usernameC);
    await pageC.fill('#password', 'testpass123');
    await pageC.click('.auth-btn');
    await pageC.waitForSelector('.app-container', { timeout: 30000 });
    console.log('C logged in');

    // Wait for queued messages
    await pageC.waitForTimeout(5000);

    // C should have an unread message from A
    console.log('C checking for offline message from A...');
    await pageC.click('.nav-btn[data-tab="inbox"]');
    await pageC.waitForTimeout(1000);

    const cOfflineUnread = await pageC.locator(`.friend-item[data-userid="${userAId}"] .message-indicator.unread`).count();
    console.log('C has offline unread from A:', cOfflineUnread === 1 ? 'YES' : 'NO');
    expect(cOfflineUnread).toBe(1);

    // C views the offline message
    await pageC.locator(`.friend-item[data-userid="${userAId}"]`).click();
    await expect(pageC.locator('.message-viewer')).toBeVisible({ timeout: 10000 });
    console.log('C viewed offline message from A!');

    console.log('=== ALL OFFLINE MESSAGES RECEIVED! ===');

    await contextA.close();
    await contextB.close();
    await contextC.close();
  });

});
