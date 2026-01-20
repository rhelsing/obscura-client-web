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

});
