/**
 * E2E Scenario 13 - Device Unlink (Self-Unlink)
 *
 * Tests that "Unlink Device" completely wipes local data so
 * a fresh user can register in the same browser.
 *
 * Setup: Bob with 2 devices (bob1, bob2)
 *
 * Tests:
 *   13.1 Bob2 unlinks itself via Settings
 *   13.2 Bob2's browser is clean (can register new user bob3)
 *   13.3 Bob3 registers successfully in bob2's browser context
 *   13.4 Logout from link-pending, re-login still shows link-pending
 */
import { test, expect } from '@playwright/test';

const delay = (ms = 300) => new Promise(r => setTimeout(r, ms));

function randomUsername() {
  return 'test_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
}

test.describe('Scenario 13: Device Unlink', () => {

  test('Unlink device, register new user in same browser', async ({ browser }) => {
    test.setTimeout(180000); // 3 minutes

    // ============================================================
    // SETUP: Create browser contexts
    // ============================================================
    const bob1Context = await browser.newContext();
    const bob2Context = await browser.newContext();
    const bob1Page = await bob1Context.newPage();
    const bob2Page = await bob2Context.newPage();

    bob1Page.on('dialog', dialog => dialog.accept());
    bob2Page.on('dialog', dialog => dialog.accept());
    bob1Page.on('console', msg => console.log('[bob1]', msg.text()));
    bob2Page.on('console', msg => console.log('[bob2]', msg.text()));

    const bobUsername = randomUsername();
    const bob3Username = randomUsername();
    const password = 'testpass123';

    // ============================================================
    // SETUP: Register Bob1
    // ============================================================
    console.log('\n=== SETUP: Register Bob1 ===');
    await bob1Page.goto('/register');
    await bob1Page.waitForSelector('#username', { timeout: 30000 });
    await bob1Page.fill('#username', bobUsername);
    await bob1Page.fill('#password', password);
    await bob1Page.fill('#confirm-password', password);
    await bob1Page.click('button[type="submit"]');
    await delay(300);

    await bob1Page.waitForSelector('.phrase-box', { timeout: 30000 });
    await bob1Page.check('#confirm-saved');
    await bob1Page.click('#continue-btn');
    await delay(300);
    await bob1Page.waitForURL('**/stories', { timeout: 30000 });

    let bob1Ws = false;
    for (let i = 0; i < 10; i++) {
      await delay(500);
      bob1Ws = await bob1Page.evaluate(() => window.__client?.ws?.readyState === 1);
      if (bob1Ws) break;
    }
    expect(bob1Ws).toBe(true);
    console.log('Bob1 registered and connected');

    // ============================================================
    // SETUP: Link Bob2
    // ============================================================
    console.log('\n=== SETUP: Link Bob2 ===');

    await bob2Page.goto('/login');
    await bob2Page.waitForSelector('#username', { timeout: 10000 });
    await bob2Page.fill('#username', bobUsername);
    await bob2Page.fill('#password', password);
    await bob2Page.click('button[type="submit"]');
    await delay(300);

    await bob2Page.waitForURL('**/link-pending', { timeout: 15000 });
    await bob2Page.waitForSelector('.link-code', { timeout: 10000 });
    const bob2LinkCode = await bob2Page.$eval('.link-code', el => el.value || el.textContent);
    console.log('Bob2 link code:', bob2LinkCode.slice(0, 20) + '...');

    // Bob1 approves Bob2
    await bob1Page.evaluate(async (code) => {
      await window.__client.approveLink(code);
      await window.__client.announceDevices();
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

    // Verify Bob1 sees Bob2 in device list
    const bob1DeviceCount = await bob1Page.evaluate(() => window.__client.devices.getAll().length);
    expect(bob1DeviceCount).toBe(1);
    console.log('Bob1 sees 1 other device (Bob2)');

    // ============================================================
    // SCENARIO 13.1: Bob2 unlinks itself
    // ============================================================
    console.log('\n=== 13.1: Bob2 unlinks itself ===');

    await bob2Page.goto('/settings');
    await bob2Page.waitForSelector('button[modal="unlink-modal"]', { timeout: 10000 });
    await bob2Page.click('button[modal="unlink-modal"]');

    // Wait for modal confirm button to be visible and click it
    await delay(500);
    await bob2Page.waitForSelector('#confirm-unlink', { timeout: 5000 });
    await bob2Page.click('#confirm-unlink');

    // Should navigate to login after unlink
    await bob2Page.waitForURL('**/login', { timeout: 15000 });
    console.log('Bob2 unlinked and redirected to login');

    // ============================================================
    // SCENARIO 13.2: Verify Bob2's browser is clean
    // ============================================================
    console.log('\n=== 13.2: Verify browser is clean ===');

    // Try to login as Bob again - should get newDevice status
    await bob2Page.fill('#username', bobUsername);
    await bob2Page.fill('#password', password);
    await bob2Page.click('button[type="submit"]');
    await delay(500);

    // Should go to link-pending (newDevice scenario)
    await bob2Page.waitForURL('**/link-pending', { timeout: 15000 });
    console.log('Bob login in cleaned browser triggers link-pending (newDevice)');

    // Go back to login for fresh user test
    await bob2Page.goto('/login');
    await delay(300);

    // ============================================================
    // SCENARIO 13.3: Register Bob3 in Bob2's browser
    // ============================================================
    console.log('\n=== 13.3: Register Bob3 in same browser ===');

    await bob2Page.goto('/register');
    await bob2Page.waitForSelector('#username', { timeout: 10000 });
    await bob2Page.fill('#username', bob3Username);
    await bob2Page.fill('#password', password);
    await bob2Page.fill('#confirm-password', password);
    await bob2Page.click('button[type="submit"]');
    await delay(300);

    // Should get to recovery phrase page
    await bob2Page.waitForSelector('.phrase-box', { timeout: 30000 });
    console.log('Bob3 registration - recovery phrase shown');

    await bob2Page.check('#confirm-saved');
    await bob2Page.click('#continue-btn');
    await delay(300);

    // Should reach stories page
    await bob2Page.waitForURL('**/stories', { timeout: 30000 });

    let bob3Ws = false;
    for (let i = 0; i < 10; i++) {
      await delay(500);
      bob3Ws = await bob2Page.evaluate(() => window.__client?.ws?.readyState === 1);
      if (bob3Ws) break;
    }
    expect(bob3Ws).toBe(true);

    // Verify it's actually Bob3, not Bob
    const loggedInUsername = await bob2Page.evaluate(() => window.__client.username);
    expect(loggedInUsername).toBe(bob3Username);
    console.log('Bob3 registered successfully in Bob2\'s former browser');

    console.log('\n=== SCENARIO 13 COMPLETE ===\n');

    // ============================================================
    // CLEANUP
    // ============================================================
    await bob1Context.close();
    await bob2Context.close();
  });

  test('Logout from link-pending, re-login still works', async ({ browser }) => {
    test.setTimeout(120000); // 2 minutes

    // ============================================================
    // SETUP: Create browser contexts
    // ============================================================
    const device1Context = await browser.newContext();
    const device2Context = await browser.newContext();
    const device1Page = await device1Context.newPage();
    const device2Page = await device2Context.newPage();

    device1Page.on('dialog', dialog => dialog.accept());
    device2Page.on('dialog', dialog => dialog.accept());
    device1Page.on('console', msg => console.log('[device1]', msg.text()));
    device2Page.on('console', msg => console.log('[device2]', msg.text()));

    const username = randomUsername();
    const password = 'testpass123';

    // ============================================================
    // SETUP: Register Device1
    // ============================================================
    console.log('\n=== SETUP: Register Device1 ===');
    await device1Page.goto('/register');
    await device1Page.waitForSelector('#username', { timeout: 30000 });
    await device1Page.fill('#username', username);
    await device1Page.fill('#password', password);
    await device1Page.fill('#confirm-password', password);
    await device1Page.click('button[type="submit"]');
    await delay(300);

    await device1Page.waitForSelector('.phrase-box', { timeout: 30000 });
    await device1Page.check('#confirm-saved');
    await device1Page.click('#continue-btn');
    await delay(300);
    await device1Page.waitForURL('**/stories', { timeout: 30000 });

    let device1Ws = false;
    for (let i = 0; i < 10; i++) {
      await delay(500);
      device1Ws = await device1Page.evaluate(() => window.__client?.ws?.readyState === 1);
      if (device1Ws) break;
    }
    expect(device1Ws).toBe(true);
    console.log('Device1 registered and connected');

    // ============================================================
    // SCENARIO 13.4: Device2 login goes to link-pending
    // ============================================================
    console.log('\n=== 13.4: Device2 login goes to link-pending ===');

    await device2Page.goto('/login');
    await device2Page.waitForSelector('#username', { timeout: 10000 });
    await device2Page.fill('#username', username);
    await device2Page.fill('#password', password);
    await device2Page.click('button[type="submit"]');
    await delay(500);

    // Should go to link-pending (newDevice scenario)
    await device2Page.waitForURL('**/link-pending', { timeout: 15000 });
    console.log('Device2 first login - link-pending page shown');

    // Get the link code for comparison later
    await device2Page.waitForSelector('.link-code', { timeout: 10000 });
    const firstLinkCode = await device2Page.$eval('.link-code', el => el.value || el.textContent);
    console.log('First link code:', firstLinkCode.slice(0, 20) + '...');

    // ============================================================
    // Navigate away from link-pending (simulate logout without approval)
    // ============================================================
    console.log('\n=== 13.4: Navigate to login (simulating logout) ===');
    await device2Page.goto('/login');
    await delay(500);

    // ============================================================
    // Re-login should STILL go to link-pending (not error/broken state)
    // ============================================================
    console.log('\n=== 13.4: Re-login should still go to link-pending ===');

    await device2Page.waitForSelector('#username', { timeout: 10000 });
    await device2Page.fill('#username', username);
    await device2Page.fill('#password', password);
    await device2Page.click('button[type="submit"]');
    await delay(500);

    // Should still go to link-pending (not error or directly to stories)
    await device2Page.waitForURL('**/link-pending', { timeout: 15000 });
    console.log('Device2 re-login - link-pending page shown again (CORRECT BEHAVIOR)');

    // Get the new link code - should be different (fresh challenge)
    await device2Page.waitForSelector('.link-code', { timeout: 10000 });
    const secondLinkCode = await device2Page.$eval('.link-code', el => el.value || el.textContent);
    console.log('Second link code:', secondLinkCode.slice(0, 20) + '...');

    // Link codes should be different (fresh challenge each time)
    expect(secondLinkCode).not.toBe(firstLinkCode);
    console.log('Link codes are different - fresh challenge generated');

    // ============================================================
    // Now complete the linking to verify it still works
    // ============================================================
    console.log('\n=== 13.4: Complete linking to verify it works ===');

    await device1Page.evaluate(async (code) => {
      await window.__client.approveLink(code);
      await window.__client.announceDevices();
    }, secondLinkCode);

    await device2Page.waitForURL('**/stories', { timeout: 20000 });

    let device2Ws = false;
    for (let i = 0; i < 10; i++) {
      await delay(500);
      device2Ws = await device2Page.evaluate(() => window.__client?.ws?.readyState === 1);
      if (device2Ws) break;
    }
    expect(device2Ws).toBe(true);
    console.log('Device2 linked and connected successfully');

    // Verify the username is correct
    const loggedInUsername = await device2Page.evaluate(() => window.__client.username);
    expect(loggedInUsername).toBe(username);
    console.log('Correct username after completing link');

    console.log('\n=== SCENARIO 13.4 COMPLETE ===\n');

    // ============================================================
    // CLEANUP
    // ============================================================
    await device1Context.close();
    await device2Context.close();
  });

});
