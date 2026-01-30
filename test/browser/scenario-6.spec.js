/**
 * E2E Scenario 6 - Message Attachments
 *
 * Minimal setup: Register Alice & Bob, make friends, link Bob2, then test attachments.
 */
import { test, expect } from '@playwright/test';
import fs from 'fs';
import path from 'path';

const delay = (ms = 300) => new Promise(r => setTimeout(r, ms));

function randomUsername() {
  return 'test_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
}

test.describe('Scenario 6: Attachments', () => {

  test('Upload, fan-out, download, integrity, persistence', async ({ browser }) => {
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
    bobPage.on('console', msg => console.log('[bob]', msg.text()));

    const username = randomUsername();
    const bobUsername = randomUsername();
    const password = 'testpass123';

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

    let bobWs = false;
    for (let i = 0; i < 10; i++) {
      await delay(500);
      bobWs = await bobPage.evaluate(() => window.__client?.ws?.readyState === 1);
      if (bobWs) break;
    }
    expect(bobWs).toBe(true);
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
    // SETUP: Link Bob2 (for fan-out testing)
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

    // ============================================================
    // SCENARIO 6: Message Attachments
    // ============================================================
    console.log('\n=== SCENARIO 6: Attachments ===');

    // --- 6.1: Navigate everyone to chat pages first ---
    await bobPage.goto(`/messages/${username}`);
    await bobPage.waitForSelector('#message-text');
    await bob2Page.goto(`/messages/${username}`);
    await bob2Page.waitForSelector('#message-text');
    await page.goto(`/messages/${bobUsername}`);
    await page.waitForSelector('#message-text');
    console.log('All users on chat pages');

    // Set up listeners BEFORE Alice sends
    const bobAttachPromise = bobPage.waitForEvent('console', {
      predicate: msg => msg.text().includes('[ws] Message: CONTENT_REFERENCE'),
      timeout: 15000,
    });
    const bob2AttachPromise = bob2Page.waitForEvent('console', {
      predicate: msg => msg.text().includes('[ws] Message: CONTENT_REFERENCE'),
      timeout: 15000,
    });

    // Load test image from disk
    const testImagePath = path.join(process.cwd(), 'test_image.jpg');
    const testImageBuffer = fs.readFileSync(testImagePath);
    const testImageBytes = Array.from(testImageBuffer);
    console.log('Loaded test image:', testImageBytes.length, 'bytes');

    // Alice sends attachment via file input UI
    const fileInput = await page.$('#file-input');
    await fileInput.setInputFiles(testImagePath);
    await delay(500);
    console.log('Alice sent attachment via UI');

    // --- Test: Sender sees image (not placeholder) ---
    await page.waitForSelector('.message.sent .attachment-image', { timeout: 10000 });
    const senderImage = await page.$('.message.sent .attachment-image');
    expect(senderImage).not.toBeNull();
    console.log('Sender sees attachment image ✓');

    // --- Test: Scroll is at bottom after sending image ---
    const senderScrollCheck = await page.evaluate(() => {
      const mc = document.querySelector('#messages');
      if (!mc) return { error: 'no messages container' };
      const isAtBottom = mc.scrollTop + mc.clientHeight >= mc.scrollHeight - 10;
      return { isAtBottom, scrollTop: mc.scrollTop, clientHeight: mc.clientHeight, scrollHeight: mc.scrollHeight };
    });
    expect(senderScrollCheck.isAtBottom).toBe(true);
    console.log('Sender scroll at bottom after image ✓');

    // Both bob devices should receive
    await Promise.all([bobAttachPromise, bob2AttachPromise]);
    console.log('Both bob devices received attachment (fan-out works)');

    // Wait for image to auto-download and display in Bob's chat UI
    await bobPage.waitForSelector('.attachment-image', { timeout: 15000 });
    console.log('Bob sees attachment image in chat UI');

    // --- Test: Receiver scroll is at bottom after image loads ---
    await delay(200);
    const receiverScrollCheck = await bobPage.evaluate(() => {
      const mc = document.querySelector('#messages');
      if (!mc) return { error: 'no messages container' };
      const isAtBottom = mc.scrollTop + mc.clientHeight >= mc.scrollHeight - 10;
      return { isAtBottom, scrollTop: mc.scrollTop, clientHeight: mc.clientHeight, scrollHeight: mc.scrollHeight };
    });
    expect(receiverScrollCheck.isAtBottom).toBe(true);
    console.log('Receiver scroll at bottom after image loads ✓');

    // --- 6.2: Bob downloads and verifies integrity ---
    const downloadResult = await bobPage.evaluate(async () => {
      const attachments = window.__client.messages.filter(m => m.contentReference);
      if (attachments.length === 0) return { error: 'No attachments found' };

      const ref = attachments[attachments.length - 1].contentReference;
      const decrypted = await window.__client.attachments.download(ref);
      return {
        size: decrypted.byteLength,
        header: Array.from(new Uint8Array(decrypted.slice(0, 4)))
      };
    });

    expect(downloadResult.error).toBeUndefined();
    expect(downloadResult.size).toBe(testImageBytes.length);
    expect(downloadResult.header[0]).toBe(0xFF);
    expect(downloadResult.header[1]).toBe(0xD8);
    expect(downloadResult.header[2]).toBe(0xFF);
    console.log('Bob downloaded and verified attachment:', downloadResult.size, 'bytes (JPEG header valid)');

    // --- 6.2b: Verify cache works (second download should hit cache) ---
    // Use window state tracking instead of console listeners (avoids race conditions)
    const cachedResult = await bobPage.evaluate(async () => {
      // Clear any previous cache action
      window.__lastCacheAction = null;

      const attachments = window.__client.messages.filter(m => m.contentReference);
      const ref = attachments[attachments.length - 1].contentReference;
      const decrypted = await window.__client.attachments.download(ref);

      // Return both the result and the cache action
      return {
        size: decrypted.byteLength,
        cacheAction: window.__lastCacheAction,
      };
    });

    expect(cachedResult.size).toBe(testImageBytes.length);
    expect(cachedResult.cacheAction?.type).toBe('hit');
    console.log('Bob second download hit cache ✓');

    await delay(500);

    // --- 6.3: Bob2 can also download ---
    const download2Result = await bob2Page.evaluate(async () => {
      const attachments = window.__client.messages.filter(m => m.contentReference);
      if (attachments.length === 0) return { error: 'No attachments found' };

      const ref = attachments[attachments.length - 1].contentReference;
      const decrypted = await window.__client.attachments.download(ref);
      return { size: decrypted.byteLength };
    });

    expect(download2Result.size).toBe(testImageBytes.length);
    console.log('Bob2 also downloaded attachment successfully');

    // --- 6.4: Test attachment persistence ---
    await delay(500);

    await page.goto('/chats');
    await delay(500);
    await page.goto(`/messages/${bobUsername}`);
    await page.waitForSelector('#messages', { timeout: 10000 });
    await delay(500);
    await page.waitForSelector('.attachment-image', { timeout: 15000 });
    const persistedImage = await page.$('.message.sent .attachment-image');
    expect(persistedImage).not.toBeNull();
    console.log('Attachment persists after leaving and returning ✓');

    await delay(500);

    await bobPage.goto('/chats');
    await delay(500);
    await bobPage.goto(`/messages/${username}`);
    await bobPage.waitForSelector('#messages', { timeout: 10000 });
    await delay(500);
    await bobPage.waitForSelector('.attachment-image', { timeout: 15000 });
    const bobPersistedImage = await bobPage.$('.attachment-image');
    expect(bobPersistedImage).not.toBeNull();
    console.log('Bob sees attachment after leaving and returning ✓');

    // --- 6.5: Test receiver on different page (not chat) ---
    console.log('\n--- 6.5: Receiver on different page ---');

    // Bob navigates away from chat to /stories
    await bobPage.goto('/stories');

    // Wait for Bob to be connected via state polling (not console)
    let bobConnected = false;
    for (let i = 0; i < 20; i++) {
      await delay(500);
      bobConnected = await bobPage.evaluate(() => window.__client?.ws?.readyState === 1);
      if (bobConnected) break;
    }
    expect(bobConnected).toBe(true);
    console.log('Bob navigated to /stories and connected');

    // Track any errors on Bob's page
    const bobErrors = [];
    const errorHandler = msg => {
      const text = msg.text();
      if (text.includes('error') || text.includes('Error') || text.includes('Failed')) {
        bobErrors.push(text);
      }
    };
    bobPage.on('console', errorHandler);

    // Alice navigates to chat first
    await page.goto(`/messages/${bobUsername}`);
    await page.waitForSelector('#message-text');

    // Wait for Alice to be connected
    let aliceConnected = false;
    for (let i = 0; i < 10; i++) {
      await delay(500);
      aliceConnected = await page.evaluate(() => window.__client?.ws?.readyState === 1);
      if (aliceConnected) break;
    }
    expect(aliceConnected).toBe(true);

    // Record Bob's initial message count
    const bobInitialMsgCount = await bobPage.evaluate(() =>
      window.__client?.messages?.filter(m => m.contentReference)?.length || 0
    );

    // Wait for chat view to be fully rendered
    await page.waitForSelector('#message-text', { timeout: 15000 });
    await delay(1000); // Give time for full render

    // Count Alice's current attachment images in DOM
    const aliceInitialImages = await page.$$eval('.attachment-image', els => els.length);
    console.log('Alice has', aliceInitialImages, 'existing attachments');

    // Use setInputFiles with the selector directly
    await page.setInputFiles('#file-input', testImagePath);
    console.log('File input triggered');

    // Wait for Alice's UI to show the new attachment (DOM-based, longer timeout)
    await page.waitForFunction(
      (count) => document.querySelectorAll('.attachment-image').length > count,
      { timeout: 30000 },
      aliceInitialImages
    );
    console.log('Alice sent attachment while Bob on /stories');

    // Poll for Bob to receive it in background (state-based, not console-based)
    let bobReceivedInBg = false;
    for (let i = 0; i < 30; i++) {
      await delay(500);
      const bobNewMsgCount = await bobPage.evaluate(() =>
        window.__client?.messages?.filter(m => m.contentReference)?.length || 0
      );
      if (bobNewMsgCount > bobInitialMsgCount) {
        bobReceivedInBg = true;
        break;
      }
    }
    expect(bobReceivedInBg).toBe(true);
    console.log('Bob received attachment while on /stories ✓');

    bobPage.off('console', errorHandler);

    // Verify no critical errors (sending chain errors are now suppressed but logged)
    const criticalErrors = bobErrors.filter(e =>
      e.includes('decrypt') && !e.includes('SendingChainError')
    );
    if (criticalErrors.length > 0) {
      console.log('ERRORS on Bob:', criticalErrors);
    }
    expect(criticalErrors.length).toBe(0);
    console.log('No decryption errors ✓');

    // --- 6.6: Test receiver logged out (queued delivery) ---
    console.log('\n--- 6.6: Offline attachment delivery ---');

    // Bob logs out
    await bobPage.goto('/settings');
    await bobPage.click('button[modal="logout-modal"]');
    await delay(300);
    await bobPage.click('#confirm-logout');
    await bobPage.waitForURL('**/login');
    console.log('Bob logged out');

    // Alice sends attachment while Bob is offline
    await page.goto(`/messages/${bobUsername}`);
    await page.waitForSelector('#message-text');

    // Wait for Alice to be connected first
    let aliceReadyForOffline = false;
    for (let i = 0; i < 10; i++) {
      await delay(500);
      aliceReadyForOffline = await page.evaluate(() => window.__client?.ws?.readyState === 1);
      if (aliceReadyForOffline) break;
    }
    expect(aliceReadyForOffline).toBe(true);

    const fileInput3 = await page.$('#file-input');
    await fileInput3.setInputFiles(testImagePath);

    // Wait for Alice to confirm she sent it
    const initialAliceAttachments = await page.$$eval('.attachment-image', els => els.length);
    await page.waitForFunction(
      (count) => document.querySelectorAll('.attachment-image').length > count,
      { timeout: 15000 },
      initialAliceAttachments
    );
    console.log('Alice sent attachment while Bob offline');

    // Bob logs back in
    await bobPage.fill('#username', bobUsername);
    await bobPage.fill('#password', password);
    await bobPage.click('button[type="submit"]');
    await bobPage.waitForURL('**/stories');

    // Wait for WebSocket to be ready
    let bobWsReady = false;
    for (let i = 0; i < 20; i++) {
      await delay(500);
      bobWsReady = await bobPage.evaluate(() => window.__client?.ws?.readyState === 1);
      if (bobWsReady) break;
    }
    expect(bobWsReady).toBe(true);
    console.log('Bob logged back in and connected');

    // Wait for queued messages to be delivered (poll for message count increase)
    let bobReceivedQueued = false;
    for (let i = 0; i < 30; i++) {
      await delay(500);
      const bobMsgCount = await bobPage.evaluate(() =>
        window.__client?.messages?.filter(m => m.contentReference)?.length || 0
      );
      // We expect at least 2 attachments now (one from 6.1, one from this test)
      if (bobMsgCount >= 2) {
        bobReceivedQueued = true;
        break;
      }
    }
    expect(bobReceivedQueued).toBe(true);
    console.log('Bob received queued attachment');

    // Navigate to chat and verify attachment is there
    await bobPage.goto(`/messages/${username}`);
    await bobPage.waitForSelector('#messages', { timeout: 10000 });

    // Wait for attachments to render
    await bobPage.waitForFunction(
      () => document.querySelectorAll('.attachment-image').length >= 2,
      { timeout: 15000 }
    );

    const attachmentCount = await bobPage.$$eval('.attachment-image', els => els.length);
    expect(attachmentCount).toBeGreaterThanOrEqual(2);
    console.log('Bob sees', attachmentCount, 'attachments after logging back in ✓');

    console.log('\n=== SCENARIO 6 COMPLETE ===\n');

    // ============================================================
    // CLEANUP
    // ============================================================
    await bob2Context.close();
    await aliceContext.close();
    await bobContext.close();
  });

});
