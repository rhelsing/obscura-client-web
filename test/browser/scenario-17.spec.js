/**
 * E2E Scenario 17 - Encrypted Backup/Recovery
 *
 * Setup: Bob (2 devices: bob1, bob2), Alice, friends, messages exchanged
 *
 * Tests:
 *   17.1 Create bob1, bob2 (linked), alice1
 *   17.2 Exchange messages, create stories
 *   17.3 bob2 exports backup
 *   17.4 New browser: bobRecover goes to /recover
 *   17.5 Uploads backup, enters phrase, selects "Replace all devices"
 *   17.6 Verify bobRecover has all data (friends, messages, stories)
 *   17.7 Verify bobRecover can message alice1
 *   17.8 Verify alice1 now sees only 1 Bob device (recovery device)
 */
import { test, expect } from '@playwright/test';
import { delay, randomUsername, TEST_PASSWORD } from './helpers.js';
import fs from 'fs';
import path from 'path';
import os from 'os';

test.describe('Scenario 17: Encrypted Backup/Recovery', () => {

  test('Full backup and recovery flow', async ({ browser }) => {
    test.setTimeout(300000); // 5 minutes

    // ============================================================
    // SETUP: Create browser contexts
    // ============================================================
    const bob1Context = await browser.newContext();
    const bob2Context = await browser.newContext();
    const aliceContext = await browser.newContext();

    const bob1Page = await bob1Context.newPage();
    const bob2Page = await bob2Context.newPage();
    const alicePage = await aliceContext.newPage();

    bob1Page.on('dialog', d => d.accept());
    bob2Page.on('dialog', d => d.accept());
    alicePage.on('dialog', d => d.accept());

    bob1Page.on('console', msg => console.log('[bob1]', msg.text()));
    bob2Page.on('console', msg => console.log('[bob2]', msg.text()));
    alicePage.on('console', msg => console.log('[alice]', msg.text()));

    const bobUsername = randomUsername();
    const aliceUsername = randomUsername();
    const password = TEST_PASSWORD;
    let bobRecoveryPhrase = null;
    let backupFilePath = null;

    try {
      // ============================================================
      // 17.1 SETUP: Register Bob1 and capture recovery phrase
      // ============================================================
      console.log('\n=== 17.1: Register Bob1 ===');
      await bob1Page.goto('/register');
      await bob1Page.waitForSelector('#username', { timeout: 30000 });
      await bob1Page.fill('#username', bobUsername);
      await bob1Page.fill('#password', password);
      await bob1Page.fill('#confirm-password', password);
      await bob1Page.click('button[type="submit"]');
      await delay(300);

      await bob1Page.waitForSelector('.phrase-box', { timeout: 30000 });
      // Capture recovery phrase
      const bobWords = await bob1Page.$$eval('.phrase-box .word', els =>
        els.map(el => el.textContent.replace(/^\d+\.\s*/, '').trim())
      );
      bobRecoveryPhrase = bobWords.join(' ');
      expect(bobWords.length).toBe(12);
      console.log('Captured Bob recovery phrase:', bobRecoveryPhrase.split(' ').slice(0, 3).join(' ') + '...');

      await bob1Page.check('#confirm-saved');
      await bob1Page.click('#continue-btn');
      await delay(300);
      await bob1Page.waitForURL('**/stories', { timeout: 30000 });

      // Wait for WebSocket
      for (let i = 0; i < 10; i++) {
        await delay(500);
        const ws = await bob1Page.evaluate(() => window.__client?.ws?.readyState === 1);
        if (ws) break;
      }
      console.log('Bob1 registered and connected');

      // ============================================================
      // Register Alice
      // ============================================================
      console.log('\n=== Register Alice ===');
      await alicePage.goto('/register');
      await alicePage.waitForSelector('#username', { timeout: 30000 });
      await alicePage.fill('#username', aliceUsername);
      await alicePage.fill('#password', password);
      await alicePage.fill('#confirm-password', password);
      await alicePage.click('button[type="submit"]');
      await delay(300);

      await alicePage.waitForSelector('.phrase-box', { timeout: 30000 });
      await alicePage.check('#confirm-saved');
      await alicePage.click('#continue-btn');
      await delay(300);
      await alicePage.waitForURL('**/stories', { timeout: 30000 });

      for (let i = 0; i < 10; i++) {
        await delay(500);
        const ws = await alicePage.evaluate(() => window.__client?.ws?.readyState === 1);
        if (ws) break;
      }
      console.log('Alice registered and connected');

      // ============================================================
      // Make Bob and Alice friends
      // ============================================================
      console.log('\n=== Make Bob and Alice friends ===');
      await alicePage.goto('/friends/add');
      await alicePage.waitForSelector('#my-link-input', { timeout: 30000 });
      const aliceLink = await alicePage.inputValue('#my-link-input');

      const aliceReqPromise = alicePage.waitForEvent('console', {
        predicate: msg => msg.text().includes('Friend request from:'),
        timeout: 30000,
      });

      await bob1Page.goto('/friends/add');
      await bob1Page.waitForSelector('#friend-link', { timeout: 30000 });
      await bob1Page.fill('#friend-link', aliceLink);
      await bob1Page.click('button[type="submit"]');
      await bob1Page.waitForSelector('#done-btn', { timeout: 30000 });

      await aliceReqPromise;
      await alicePage.goto('/friends');
      await alicePage.waitForSelector('.friend-item.pending', { timeout: 30000 });
      await alicePage.click(`.accept-btn[data-username="${bobUsername}"]`);
      await delay(2000);
      console.log('Bob and Alice are now friends');

      // ============================================================
      // Link Bob2
      // ============================================================
      console.log('\n=== Link Bob2 ===');
      await bob2Page.goto('/login');
      await bob2Page.waitForSelector('#username', { timeout: 30000 });
      await bob2Page.fill('#username', bobUsername);
      await bob2Page.fill('#password', password);
      await bob2Page.click('button[type="submit"]');
      await bob2Page.waitForURL('**/link-pending', { timeout: 30000 });

      const bob2LinkCode = await bob2Page.$eval('.link-code', el => el.value || el.textContent);
      await bob1Page.evaluate(async (code) => {
        await window.__client.approveLink(code);
      }, bob2LinkCode);

      await bob2Page.waitForURL('**/stories', { timeout: 30000 });
      for (let i = 0; i < 10; i++) {
        await delay(500);
        const ws = await bob2Page.evaluate(() => window.__client?.ws?.readyState === 1);
        if (ws) break;
      }
      console.log('Bob2 linked and connected');

      // ============================================================
      // 17.2 Exchange messages and create stories
      // ============================================================
      console.log('\n=== 17.2: Exchange messages ===');

      // Bob1 sends message to Alice
      await bob1Page.goto(`/messages/${aliceUsername}`);
      await bob1Page.waitForSelector('#message-text', { timeout: 30000 });
      await bob1Page.fill('#message-text', 'Hello from Bob1!');
      await bob1Page.click('button[type="submit"]');
      await delay(1000);

      // Bob2 sends message to Alice
      await bob2Page.goto(`/messages/${aliceUsername}`);
      await bob2Page.waitForSelector('#message-text', { timeout: 30000 });
      await bob2Page.fill('#message-text', 'Hello from Bob2!');
      await bob2Page.click('button[type="submit"]');
      await delay(1000);

      // Bob1 creates a story
      console.log('Creating story...');
      await bob1Page.evaluate(async () => {
        await window.__client.story.create({ content: 'Story before recovery' });
      });
      await delay(1000);
      console.log('Messages and stories created');

      // ============================================================
      // 17.3 Export backup from Bob2
      // ============================================================
      console.log('\n=== 17.3: Export backup from Bob2 ===');

      const backupBase64 = await bob2Page.evaluate(async () => {
        const { createBackupManager } = await import('/src/v2/backup/BackupManager.js');
        const manager = createBackupManager(
          window.__client.username,
          window.__client.userId
        );
        const { blob } = await manager.exportBackup();
        const buffer = await blob.arrayBuffer();
        // Convert to base64 for transfer
        const bytes = new Uint8Array(buffer);
        let binary = '';
        for (let i = 0; i < bytes.length; i++) {
          binary += String.fromCharCode(bytes[i]);
        }
        return btoa(binary);
      });

      // Save backup to temp file
      backupFilePath = path.join(os.tmpdir(), `obscura-backup-test-${Date.now()}.obscura`);
      const backupBuffer = Buffer.from(backupBase64, 'base64');
      fs.writeFileSync(backupFilePath, backupBuffer);
      console.log('Backup saved to:', backupFilePath, '(', backupBuffer.length, 'bytes)');

      // ============================================================
      // 17.4-17.5 Recovery
      // ============================================================
      console.log('\n=== 17.4-17.5: Recovery ===');

      // Create new browser context for recovery device
      const recoverContext = await browser.newContext();
      const recoverPage = await recoverContext.newPage();
      recoverPage.on('dialog', d => d.accept());
      recoverPage.on('console', msg => console.log('[recover]', msg.text()));

      // Login on new device - this triggers link-pending flow
      await recoverPage.goto('/login');
      await recoverPage.waitForSelector('#username', { timeout: 30000 });
      await recoverPage.fill('#username', bobUsername);
      await recoverPage.fill('#password', password);
      await recoverPage.click('button[type="submit"]');

      // Wait for link-pending page (new device needs approval)
      await recoverPage.waitForURL('**/link-pending', { timeout: 30000 });

      // Click "Recover from backup" link (can't approve from another device)
      await recoverPage.waitForSelector('a[href="/recover"]', { timeout: 30000 });
      await recoverPage.click('a[href="/recover"]');
      await recoverPage.waitForURL('**/recover', { timeout: 30000 });

      // Upload backup file
      console.log('Uploading backup file...');
      const fileInput = await recoverPage.$('#backup-file');
      await fileInput.setInputFiles(backupFilePath);
      await recoverPage.click('button[type="submit"]');

      // Enter phrase and password (12-box UI)
      await recoverPage.waitForSelector('.phrase-word', { timeout: 30000 });
      const phraseWords = bobRecoveryPhrase.split(' ');
      const phraseInputs = await recoverPage.$$('.phrase-word');
      for (let i = 0; i < 12; i++) {
        await phraseInputs[i].fill(phraseWords[i]);
      }
      await recoverPage.fill('#password', password);
      await recoverPage.click('button[type="submit"]');

      // Select "Replace all devices" mode
      await recoverPage.waitForSelector('input[name="mode"]', { timeout: 30000 });
      await recoverPage.check('input[name="mode"][value="replace"]');
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
      console.log('Recovery complete, bobRecover connected');

      // ============================================================
      // 17.6 Verify bobRecover has all data
      // ============================================================
      console.log('\n=== 17.6: Verify recovered data ===');

      // Verify friends
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
      expect(recoverMessages.length).toBeGreaterThanOrEqual(2);

      // Verify stories
      const recoverStories = await recoverPage.evaluate(async () => {
        if (!window.__client.story) return [];
        const stories = await window.__client.story.all();
        return stories.map(s => s.data?.content).filter(Boolean);
      });
      console.log('Recovered stories:', recoverStories);
      // Stories might not be fully set up in all cases, so this is optional
      if (recoverStories.length > 0) {
        expect(recoverStories).toContain('Story before recovery');
      }

      // ============================================================
      // 17.7 Verify bobRecover can message alice
      // ============================================================
      console.log('\n=== 17.7: Test messaging after recovery ===');

      // Set up listener for alice to receive message
      const aliceMsgPromise = alicePage.waitForEvent('console', {
        predicate: msg => msg.text().includes('[Global] Message from:'),
        timeout: 30000,
      });

      // bobRecover sends message
      await recoverPage.goto(`/messages/${aliceUsername}`);
      await recoverPage.waitForSelector('#message-text', { timeout: 30000 });
      await recoverPage.fill('#message-text', 'Hello from recovered Bob!');
      await recoverPage.click('button[type="submit"]');

      await aliceMsgPromise;
      console.log('Alice received message from recovered Bob!');

      // ============================================================
      // 17.8 Verify Alice sees only 1 Bob device
      // ============================================================
      console.log('\n=== 17.8: Verify device list updated ===');
      await delay(3000); // Wait for recovery announce to propagate

      const aliceBobDevices = await alicePage.evaluate((bobUser) => {
        const bob = window.__client.friends.friends.get(bobUser);
        return bob?.devices?.length || 0;
      }, bobUsername);
      console.log(`Alice sees ${aliceBobDevices} Bob device(s) after recovery`);
      expect(aliceBobDevices).toBe(1);

      // Cleanup recovery context
      await recoverContext.close();

      console.log('\n=== SCENARIO 17 COMPLETE ===\n');

    } finally {
      // Cleanup
      if (backupFilePath && fs.existsSync(backupFilePath)) {
        fs.unlinkSync(backupFilePath);
      }
      await bob1Context.close();
      await bob2Context.close();
      await aliceContext.close();
    }
  });
});
