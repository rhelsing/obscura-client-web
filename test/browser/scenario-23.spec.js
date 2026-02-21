/**
 * E2E Scenario 23 - Web Backup Upload + Server Restore
 *
 * Setup: Bob1, Alice1, friends, messages exchanged
 *
 * Tests:
 *   23.1 Register Bob1, Alice1, become friends, exchange messages
 *   23.2 Bob1 enables web backup toggle in Settings, verify upload succeeds
 *   23.3 New device (third browser): Bob logs in → link-pending → /recover
 *   23.4 Recover page detects server backup, user clicks "Restore from server"
 *   23.5 Enter recovery phrase + password, select "Replace all devices"
 *   23.6 Verify recovered data (friends, messages)
 *   23.7 Verify recovered Bob can message Alice
 */
import { test, expect } from '@playwright/test';
import { delay, randomUsername, TEST_PASSWORD } from './helpers.js';

test.describe('Scenario 23: Web Backup Upload + Server Restore', () => {

  test('Full web backup and server restore flow', async ({ browser, browserName }, testInfo) => {
    test.setTimeout(300000); // 5 minutes

    // ============================================================
    // SETUP: Create three separate browser contexts
    // ============================================================
    const bobContext = await browser.newContext();
    const aliceContext = await browser.newContext();
    const recoverContext = await browser.newContext();

    const bobPage = await bobContext.newPage();
    const alicePage = await aliceContext.newPage();
    const recoverPage = await recoverContext.newPage();

    bobPage.on('dialog', d => d.accept());
    alicePage.on('dialog', d => d.accept());
    recoverPage.on('dialog', d => d.accept());

    bobPage.on('console', msg => console.log('[bob]', msg.text()));
    alicePage.on('console', msg => console.log('[alice]', msg.text()));
    recoverPage.on('console', msg => console.log('[recover]', msg.text()));

    const bobUsername = randomUsername();
    const aliceUsername = randomUsername();
    const password = TEST_PASSWORD;
    let bobRecoveryPhrase = null;

    try {
      // ============================================================
      // 23.1 Register Bob, Alice, become friends, exchange messages
      // ============================================================
      console.log('\n=== 23.1: Register Bob ===');
      await bobPage.goto('/register');
      await bobPage.waitForSelector('#username', { timeout: 30000 });
      await bobPage.fill('#username', bobUsername);
      await bobPage.fill('#password', password);
      await bobPage.fill('#confirm-password', password);
      await delay(500);
      await bobPage.click('button[type="submit"]');
      await delay(500);

      await bobPage.waitForSelector('.phrase-box', { timeout: 30000 });
      const bobWords = await bobPage.$$eval('.phrase-box .word', els =>
        els.map(el => el.textContent.replace(/^\d+\.\s*/, '').trim())
      );
      bobRecoveryPhrase = bobWords.join(' ');
      expect(bobWords.length).toBe(12);
      console.log('Captured Bob recovery phrase:', bobRecoveryPhrase.split(' ').slice(0, 3).join(' ') + '...');

      await bobPage.check('#confirm-saved');
      await delay(500);
      await bobPage.click('#continue-btn');
      await delay(500);
      await bobPage.waitForURL('**/stories', { timeout: 30000 });

      for (let i = 0; i < 10; i++) {
        await delay(500);
        const ws = await bobPage.evaluate(() => window.__client?.ws?.readyState === 1);
        if (ws) break;
      }
      console.log('Bob registered and connected');

      // Register Alice
      console.log('\n=== Register Alice ===');
      await delay(500);
      await alicePage.goto('/register');
      await alicePage.waitForSelector('#username', { timeout: 30000 });
      await alicePage.fill('#username', aliceUsername);
      await alicePage.fill('#password', password);
      await alicePage.fill('#confirm-password', password);
      await delay(500);
      await alicePage.click('button[type="submit"]');
      await delay(500);

      await alicePage.waitForSelector('.phrase-box', { timeout: 30000 });
      await alicePage.check('#confirm-saved');
      await delay(500);
      await alicePage.click('#continue-btn');
      await delay(500);
      await alicePage.waitForURL('**/stories', { timeout: 30000 });

      for (let i = 0; i < 10; i++) {
        await delay(500);
        const ws = await alicePage.evaluate(() => window.__client?.ws?.readyState === 1);
        if (ws) break;
      }
      console.log('Alice registered and connected');

      // Make friends
      console.log('\n=== Make Bob and Alice friends ===');
      await delay(500);
      await alicePage.goto('/friends/add');
      await alicePage.waitForSelector('#my-link-input', { timeout: 30000 });
      const aliceLink = await alicePage.inputValue('#my-link-input');

      const aliceReqPromise = alicePage.waitForEvent('console', {
        predicate: msg => msg.text().includes('Friend request from:'),
        timeout: 30000,
      });

      await delay(500);
      await bobPage.goto('/friends/add');
      await bobPage.waitForSelector('#friend-link', { timeout: 30000 });
      await bobPage.fill('#friend-link', aliceLink);
      await delay(500);
      await bobPage.click('button[type="submit"]');
      await bobPage.waitForSelector('#done-btn', { timeout: 30000 });

      await aliceReqPromise;
      await delay(500);
      await alicePage.goto('/friends');
      await alicePage.waitForSelector('.friend-item.pending', { timeout: 30000 });
      await delay(500);
      await alicePage.click(`.accept-btn[data-username="${bobUsername}"]`);
      await delay(2000);
      console.log('Bob and Alice are now friends');

      // Exchange messages
      console.log('\n=== Exchange messages ===');
      await delay(500);
      await bobPage.goto(`/messages/${aliceUsername}`);
      await bobPage.waitForSelector('#message-text', { timeout: 30000 });
      await bobPage.fill('#message-text', 'Hello from Bob before web backup!');
      await delay(500);
      await bobPage.click('button[type="submit"]');
      await delay(1000);
      console.log('Message sent');

      // ============================================================
      // 23.2 Enable web backup toggle, verify upload
      // ============================================================
      console.log('\n=== 23.2: Enable web backup ===');
      await delay(500);
      await bobPage.goto('/settings');
      await bobPage.waitForSelector('#web-backup-toggle', { timeout: 30000 });

      // Enable web backup toggle
      await delay(500);
      await bobPage.click('#web-backup-toggle');

      // Wait for upload to complete (or fail)
      await bobPage.waitForFunction(
        () => {
          const status = document.querySelector('#web-backup-status');
          if (!status) return false;
          const text = status.textContent;
          return text.startsWith('Last backup:') || text.startsWith('Backup failed:');
        },
        { timeout: 60000 }
      );
      const backupStatusText = await bobPage.$eval('#web-backup-status', el => el.textContent);
      console.log('Web backup status:', backupStatusText);
      expect(backupStatusText).toMatch(/^Last backup:/);
      console.log('Web backup uploaded successfully');

      // Verify server has the backup
      await delay(500);
      const backupCheck = await bobPage.evaluate(async () => {
        const { createClient } = await import('/src/v2/api/client.js');
        const apiClient = createClient(window.__client.apiUrl);
        apiClient.setToken(window.__client.shellToken || window.__client.token);
        const check = await apiClient.checkBackup();
        return { exists: check.exists, size: check.size };
      });
      expect(backupCheck.exists).toBe(true);
      console.log('Server backup confirmed:', backupCheck.size, 'bytes');

      // ============================================================
      // 23.3 New device (third browser): Login as Bob → link-pending → /recover
      // ============================================================
      console.log('\n=== 23.3: New device login ===');

      await delay(500);
      await recoverPage.goto('/login');
      await recoverPage.waitForSelector('#username', { timeout: 30000 });
      await recoverPage.fill('#username', bobUsername);
      await recoverPage.fill('#password', password);
      await delay(500);
      await recoverPage.click('button[type="submit"]');

      await recoverPage.waitForURL('**/link-pending', { timeout: 30000 });
      console.log('New device at link-pending');

      // Navigate to recover page
      await delay(500);
      await recoverPage.waitForSelector('a[href="/recover"]', { timeout: 30000 });
      await recoverPage.click('a[href="/recover"]');
      await recoverPage.waitForURL('**/recover', { timeout: 30000 });

      // ============================================================
      // 23.4 Server backup detected, click "Restore from server"
      // ============================================================
      console.log('\n=== 23.4: Restore from server backup ===');

      await recoverPage.waitForSelector('#restore-from-server', { timeout: 30000 });
      console.log('Server backup detected, button visible');

      await delay(500);
      await recoverPage.click('#restore-from-server');

      // Should advance to phrase step
      await recoverPage.waitForSelector('.phrase-word', { timeout: 30000 });
      console.log('Backup downloaded, now on phrase step');

      // ============================================================
      // 23.5 Enter recovery phrase + password, select mode
      // ============================================================
      console.log('\n=== 23.5: Enter phrase and recover ===');

      const phraseWords = bobRecoveryPhrase.split(' ');
      const phraseInputs = await recoverPage.$$('.phrase-word');
      for (let i = 0; i < 12; i++) {
        await phraseInputs[i].fill(phraseWords[i]);
      }
      await recoverPage.fill('#password', password);
      await delay(500);
      await recoverPage.click('button[type="submit"]');

      // Select "Replace all devices" mode
      await recoverPage.waitForSelector('input[name="mode"]', { timeout: 30000 });
      await recoverPage.check('input[name="mode"][value="replace"]');
      await delay(500);
      await recoverPage.click('button[type="submit"]');

      // Wait for recovery to complete
      console.log('Waiting for recovery to complete...');
      await recoverPage.waitForURL('**/stories', { timeout: 120000 });

      // Wait for WebSocket connection
      for (let i = 0; i < 20; i++) {
        await delay(500);
        const ws = await recoverPage.evaluate(() => window.__client?.ws?.readyState === 1);
        if (ws) break;
      }
      console.log('Recovery complete, recovered Bob connected');

      // ============================================================
      // 23.6 Verify restored data
      // ============================================================
      console.log('\n=== 23.6: Verify recovered data ===');

      // Verify friends
      await delay(500);
      const recoverFriends = await recoverPage.evaluate(() => {
        return window.__client.friends.getAll().map(f => f.username);
      });
      console.log('Recovered friends:', recoverFriends);
      expect(recoverFriends).toContain(aliceUsername);

      // Verify messages
      const recoverMessages = await recoverPage.evaluate(async (aliceUser) => {
        const msgs = await window.__client.getMessages(aliceUser);
        return msgs.map(m => m.text || m.content).filter(Boolean);
      }, aliceUsername);
      console.log('Recovered messages:', recoverMessages);
      expect(recoverMessages.length).toBeGreaterThanOrEqual(1);

      // ============================================================
      // 23.7 Verify messaging works after recovery
      // ============================================================
      console.log('\n=== 23.7: Test messaging after recovery ===');

      const aliceMsgPromise = alicePage.waitForEvent('console', {
        predicate: msg => msg.text().includes('[Global] Message from:'),
        timeout: 30000,
      });

      await delay(500);
      await recoverPage.goto(`/messages/${aliceUsername}`);
      await recoverPage.waitForSelector('#message-text', { timeout: 30000 });
      await recoverPage.fill('#message-text', 'Hello from recovered Bob via web backup!');
      await delay(500);
      await recoverPage.click('button[type="submit"]');

      await aliceMsgPromise;
      console.log('Alice received message from recovered Bob!');

      console.log('\n=== SCENARIO 23 COMPLETE ===\n');

    } finally {
      await bobContext.close();
      await aliceContext.close();
      await recoverContext.close();
    }
  });
});
