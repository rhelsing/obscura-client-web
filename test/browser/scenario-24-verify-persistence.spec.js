/**
 * E2E Scenario 24 - Friend Verification Persistence
 *
 * Tests that verifying a friend persists across page reloads.
 *
 * Flow:
 *   1. Register Alice & Bob, make friends
 *   2. Alice verifies Bob (clicks "Codes Match")
 *   3. Confirm "verified" badge appears in friend list
 *   4. Reload the page
 *   5. Confirm "verified" badge still appears (persisted to IndexedDB)
 *   6. Confirm "Verify" button changed to "Re-verify"
 */
import { test, expect } from '@playwright/test';
import { delay, randomUsername, TEST_PASSWORD } from './helpers.js';

test.describe('Scenario 24: Friend Verification Persistence', () => {

  test('Verify friend persists across page reload', async ({ browser }) => {
    test.setTimeout(120000); // 2 minutes

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

    await page.waitForFunction(() => window.__client?.ws?.readyState === 1, { timeout: 10000 });
    console.log('Alice registered and connected');

    // ============================================================
    // SETUP: Register Bob
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
    await bobPage.check('#confirm-saved');
    await bobPage.click('#continue-btn');
    await delay(300);
    await bobPage.waitForURL('**/stories', { timeout: 30000 });

    await bobPage.waitForFunction(() => window.__client?.ws?.readyState === 1, { timeout: 10000 });
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
    // 24.1: Before verification - no verified badge
    // ============================================================
    console.log('\n--- 24.1: Before verification ---');
    await page.goto('/friends');
    await page.waitForSelector(`.friend-item[data-username="${bobUsername}"]`, { timeout: 15000 });

    // Should show "Verify" button (not "Re-verify")
    const verifyBtnBefore = await page.$eval(
      `.friend-item[data-username="${bobUsername}"] .verify-btn`,
      el => el.textContent
    );
    expect(verifyBtnBefore).toBe('Verify');
    console.log('Verify button shows "Verify" before verification ✓');

    // Should NOT show verified badge
    const verifiedBadgeBefore = await page.$(
      `.friend-item[data-username="${bobUsername}"] badge[variant="success"]`
    );
    expect(verifiedBadgeBefore).toBeNull();
    console.log('No verified badge before verification ✓');

    // ============================================================
    // 24.2: Verify Bob - click verify, then "Codes Match"
    // ============================================================
    console.log('\n--- 24.2: Verify Bob ---');
    await page.click(`.friend-item[data-username="${bobUsername}"] .verify-btn`);
    await page.waitForURL('**/friends/verify/**', { timeout: 10000 });
    await page.waitForSelector('.safety-code', { timeout: 10000 });

    // Capture the codes for logging
    const codes = await page.$$eval('.safety-code', els => els.map(el => el.textContent));
    console.log('My code:', codes[0], 'Their code:', codes[1]);

    // Click "Codes Match"
    await page.click('#match-btn');
    await page.waitForURL('**/friends', { timeout: 10000 });
    console.log('Clicked "Codes Match" - navigated back to friends');

    // ============================================================
    // 24.3: After verification - verified badge should appear
    // ============================================================
    console.log('\n--- 24.3: After verification ---');
    await page.waitForSelector(`.friend-item[data-username="${bobUsername}"]`, { timeout: 10000 });

    // Should show verified badge
    const verifiedBadgeAfter = await page.$(
      `.friend-item[data-username="${bobUsername}"] badge[variant="success"]`
    );
    expect(verifiedBadgeAfter).not.toBeNull();
    console.log('Verified badge appears after verification ✓');

    // Should show "Re-verify" button
    const verifyBtnAfter = await page.$eval(
      `.friend-item[data-username="${bobUsername}"] .verify-btn`,
      el => el.textContent
    );
    expect(verifyBtnAfter).toBe('Re-verify');
    console.log('Button changed to "Re-verify" ✓');

    // ============================================================
    // 24.4: Verify in-memory state
    // ============================================================
    console.log('\n--- 24.4: In-memory state ---');
    const inMemoryState = await page.evaluate((bobUser) => {
      const friend = window.__client?.friends?.get(bobUser);
      return {
        isVerified: friend?.isVerified,
        verifiedAt: friend?.verifiedAt,
      };
    }, bobUsername);
    expect(inMemoryState.isVerified).toBe(true);
    expect(inMemoryState.verifiedAt).toBeGreaterThan(0);
    console.log('In-memory: isVerified =', inMemoryState.isVerified, ', verifiedAt =', inMemoryState.verifiedAt, '✓');

    // ============================================================
    // 24.5: Reload the page - verified badge should STILL appear
    // ============================================================
    console.log('\n--- 24.5: Reload persistence ---');
    await page.reload();
    await page.waitForFunction(() => window.__client?.ws?.readyState === 1, { timeout: 15000 });
    await delay(500);

    await page.goto('/friends');
    await page.waitForSelector(`.friend-item[data-username="${bobUsername}"]`, { timeout: 15000 });

    // Should STILL show verified badge
    const verifiedBadgeReload = await page.$(
      `.friend-item[data-username="${bobUsername}"] badge[variant="success"]`
    );
    expect(verifiedBadgeReload).not.toBeNull();
    console.log('Verified badge persists after page reload ✓');

    // Should STILL show "Re-verify"
    const verifyBtnReload = await page.$eval(
      `.friend-item[data-username="${bobUsername}"] .verify-btn`,
      el => el.textContent
    );
    expect(verifyBtnReload).toBe('Re-verify');
    console.log('Re-verify button persists after reload ✓');

    // Verify IndexedDB state survived
    const indexedDBState = await page.evaluate((bobUser) => {
      const friend = window.__client?.friends?.get(bobUser);
      return {
        isVerified: friend?.isVerified,
        verifiedAt: friend?.verifiedAt,
      };
    }, bobUsername);
    expect(indexedDBState.isVerified).toBe(true);
    expect(indexedDBState.verifiedAt).toBeGreaterThan(0);
    console.log('IndexedDB state survived reload: isVerified =', indexedDBState.isVerified, '✓');

    // ============================================================
    // 24.6: Logout and login - verified badge should STILL appear
    // ============================================================
    console.log('\n--- 24.6: Logout/login persistence ---');
    await page.goto('/settings');
    await page.click('button[modal="logout-modal"]');
    await delay(300);
    await page.click('#confirm-logout');
    await page.waitForURL('**/login');
    console.log('Alice logged out');

    await page.fill('#username', username);
    await page.fill('#password', password);
    await page.click('button[type="submit"]');
    await page.waitForURL('**/stories', { timeout: 30000 });
    await page.waitForFunction(() => window.__client?.ws?.readyState === 1, { timeout: 15000 });
    console.log('Alice logged back in');

    await page.goto('/friends');
    await page.waitForSelector(`.friend-item[data-username="${bobUsername}"]`, { timeout: 15000 });

    const verifiedBadgeLogin = await page.$(
      `.friend-item[data-username="${bobUsername}"] badge[variant="success"]`
    );
    expect(verifiedBadgeLogin).not.toBeNull();
    console.log('Verified badge persists after logout/login ✓');

    console.log('\n=== SCENARIO 24 COMPLETE ===\n');

    // ============================================================
    // CLEANUP
    // ============================================================
    await aliceContext.close();
    await bobContext.close();
  });

});
