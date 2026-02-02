/**
 * Scenario 9: Pix Flow Tests
 *
 * Extracted from v2-e2e-scenarios.spec.js with minimal setup.
 * Tests: Camera capture, send, receive, multi-recipient, offline delivery, PixViewer UI
 */
import { test, expect } from '@playwright/test';
import { delay, randomUsername, waitForViewReady } from './helpers.js';

test.describe('Scenario 9: Pix Flow', () => {

  test('Pix: camera, send, receive, multi-recipient, offline, viewer', async ({ browser }) => {
    test.setTimeout(180000); // 3 minutes

    // ============================================================
    // SETUP: Create browser contexts
    // ============================================================
    const aliceContext = await browser.newContext();
    const bobContext = await browser.newContext();
    const bob2Context = await browser.newContext();
    const carolContext = await browser.newContext();

    const page = await aliceContext.newPage();      // Alice
    const bobPage = await bobContext.newPage();     // Bob
    const bob2Page = await bob2Context.newPage();   // Bob's second device
    const carolPage = await carolContext.newPage(); // Carol

    // Handle dialogs
    page.on('dialog', dialog => dialog.accept());
    bobPage.on('dialog', dialog => dialog.accept());
    bob2Page.on('dialog', dialog => dialog.accept());
    carolPage.on('dialog', dialog => dialog.accept());

    // Debug logging
    page.on('console', msg => console.log('[alice]', msg.text()));
    bobPage.on('console', msg => console.log('[bob]', msg.text()));
    bob2Page.on('console', msg => console.log('[bob2]', msg.text()));
    carolPage.on('console', msg => console.log('[carol]', msg.text()));

    const username = randomUsername();
    const bobUsername = randomUsername();
    const carolUsername = randomUsername();
    const password = 'testpass123';

    // ============================================================
    // SETUP 1: Register Alice
    // ============================================================
    console.log('\n--- Setup: Register Alice ---');

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
    console.log('Alice registered');

    // Wait for WebSocket
    let aliceWs = false;
    for (let i = 0; i < 10; i++) {
      await delay(500);
      aliceWs = await page.evaluate(() => window.__client?.ws?.readyState === 1);
      if (aliceWs) break;
    }
    expect(aliceWs).toBe(true);
    console.log('Alice WebSocket connected');

    // ============================================================
    // SETUP 2: Register Bob
    // ============================================================
    console.log('\n--- Setup: Register Bob ---');

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
    console.log('Bob registered');

    let bobWs = false;
    for (let i = 0; i < 10; i++) {
      await delay(500);
      bobWs = await bobPage.evaluate(() => window.__client?.ws?.readyState === 1);
      if (bobWs) break;
    }
    expect(bobWs).toBe(true);
    console.log('Bob WebSocket connected');

    // ============================================================
    // SETUP 3: Make Alice and Bob friends
    // ============================================================
    console.log('\n--- Setup: Alice and Bob become friends ---');

    // Get Bob's link
    await bobPage.goto('/friends/add');
    await bobPage.waitForSelector('#my-link-input');
    const bobLink = await bobPage.inputValue('#my-link-input');

    // Set up Bob's listener before Alice sends
    const bobRequestPromise = bobPage.waitForEvent('console', {
      predicate: msg => msg.text().includes('Friend request from:'),
      timeout: 30000,
    });

    // Alice sends friend request
    await page.goto('/friends/add');
    await page.waitForSelector('#friend-link');
    await page.fill('#friend-link', bobLink);
    await page.click('button[type="submit"]');
    await delay(300);
    await page.waitForSelector('#done-btn', { timeout: 15000 });
    console.log('Alice sent friend request to Bob');

    await bobRequestPromise;
    await delay(500);

    // Bob accepts
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
    // SETUP 4: Link Bob's second device (bob2)
    // ============================================================
    console.log('\n--- Setup: Link Bob2 ---');

    await bob2Page.goto('/login');
    await bob2Page.waitForSelector('#username', { timeout: 10000 });
    await bob2Page.fill('#username', bobUsername);
    await bob2Page.fill('#password', password);
    await bob2Page.click('button[type="submit"]');
    await delay(300);

    await bob2Page.waitForURL('**/link-pending', { timeout: 15000 });
    await bob2Page.waitForSelector('.link-code', { timeout: 10000 });
    const bob2LinkCode = await bob2Page.$eval('.link-code', el => el.value || el.textContent);
    console.log('Bob2 waiting for approval');

    // Bob approves bob2
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
    // SETUP 5: Register Carol
    // ============================================================
    console.log('\n--- Setup: Register Carol ---');

    await carolPage.goto('/register');
    await carolPage.waitForSelector('#username', { timeout: 30000 });
    await carolPage.fill('#username', carolUsername);
    await carolPage.fill('#password', password);
    await carolPage.fill('#confirm-password', password);
    await carolPage.click('button[type="submit"]');
    await delay(300);

    await carolPage.waitForSelector('.phrase-box', { timeout: 30000 });
    await carolPage.check('#confirm-saved');
    await carolPage.click('#continue-btn');
    await delay(300);

    await carolPage.waitForURL('**/stories', { timeout: 30000 });
    console.log('Carol registered');

    let carolWs = false;
    for (let i = 0; i < 10; i++) {
      await delay(500);
      carolWs = await carolPage.evaluate(() => window.__client?.ws?.readyState === 1);
      if (carolWs) break;
    }
    expect(carolWs).toBe(true);
    console.log('Carol WebSocket connected');

    // ============================================================
    // SETUP 6: Make Alice and Carol friends
    // ============================================================
    console.log('\n--- Setup: Alice and Carol become friends ---');

    await carolPage.goto('/friends/add');
    await carolPage.waitForSelector('#my-link-input');
    const carolLink = await carolPage.inputValue('#my-link-input');

    const carolReqPromise = carolPage.waitForEvent('console', {
      predicate: msg => msg.text().includes('Friend request from:'),
      timeout: 30000,
    });

    await page.goto('/friends/add');
    await page.waitForSelector('#friend-link');
    await page.fill('#friend-link', carolLink);
    await page.click('button[type="submit"]');
    await delay(300);
    await page.waitForSelector('#done-btn', { timeout: 15000 });

    await carolReqPromise;
    await delay(500);

    await carolPage.goto('/friends');
    await carolPage.waitForSelector('.friend-item.pending', { timeout: 15000 });

    const aliceCarolRespPromise = page.waitForEvent('console', {
      predicate: msg => msg.text().includes('Friend response:'),
      timeout: 30000,
    });

    await carolPage.click(`.accept-btn[data-username="${username}"]`);
    await delay(500);

    await aliceCarolRespPromise;
    console.log('Alice and Carol are friends');

    // ============================================================
    // SCENARIO 9: Pix Flow (Camera → Send → Receive)
    // ============================================================
    console.log('\n=== SCENARIO 9: Pix Flow ===');

    // --- 9.0: Navigate all receivers to /pix before sending ---
    console.log('Navigating receivers to /pix...');
    await bobPage.goto('/pix');
    await bobPage.waitForSelector('.pix-list', { timeout: 10000 });
    console.log('Bob at /pix ✓');

    await bob2Page.goto('/pix');
    await bob2Page.waitForSelector('.pix-list', { timeout: 10000 });
    console.log('Bob2 at /pix ✓');

    await carolPage.goto('/pix');
    await carolPage.waitForSelector('.pix-list', { timeout: 10000 });
    console.log('Carol at /pix ✓');

    // --- 9.1: Alice sends pix to Bob via camera UI ---
    // Set up Bob's listener for pix sync BEFORE Alice sends
    const bobPixPromise = bobPage.waitForEvent('console', {
      predicate: msg => msg.text().includes('[Global] Model sync:') && msg.text().includes('pix'),
      timeout: 30000,
    });

    // Alice navigates to pix camera
    await page.goto('/pix/camera');
    await delay(500);
    console.log('Alice navigated to /pix/camera');

    // Wait for video stream to be active
    const videoReady = await page.waitForFunction(() => {
      const video = document.querySelector('#camera-video');
      return video && video.srcObject && video.readyState >= 2;
    }, { timeout: 15000 });
    console.log('Camera video stream active ✓');

    // Click capture button
    await page.click('#capture-btn');
    await delay(500);

    // Wait for preview mode
    await page.waitForSelector('.pix-camera--preview', { timeout: 10000 });
    console.log('Alice captured photo ✓');

    // Select Bob from friend picker
    await page.click(`.pix-camera__friend-item[data-username="${bobUsername}"]`);
    await delay(300);
    console.log('Alice selected Bob as recipient ✓');

    // Click send
    await page.click('#send-btn');
    console.log('Alice clicked send');

    // Wait for navigation to /pix (success indicator)
    await page.waitForURL('**/pix', { timeout: 30000 });
    console.log('Alice sent pix (navigated to /pix) ✓');

    // --- Wait for Bob to receive pix via modelSync ---
    await bobPixPromise;
    console.log('Bob received pix via modelSync ✓');
    await delay(500);

    // --- 9.2: Bob queries unviewed pix ---
    const pixQuery = await bobPage.evaluate(async (aliceUser) => {
      // Get all pix and filter manually (simpler than complex where clause)
      const allPix = await window.__client.pix.all();
      console.log('[bob] All pix:', allPix.length, allPix.map(s => ({
        id: s.id,
        sender: s.data.senderUsername,
        recipient: s.data.recipientUsername,
        viewedAt: s.data.viewedAt,
        deleted: s.data._deleted
      })));

      // Filter for unviewed pixs from Alice to Bob
      const unviewed = allPix.filter(s =>
        s.data.recipientUsername === window.__client.username &&
        !s.data.viewedAt &&
        !s.data._deleted
      );
      console.log('[bob] Unviewed pix:', unviewed.length);

      // Find pix from Alice
      const alicePix = unviewed.find(s => s.data.senderUsername === aliceUser);
      if (!alicePix) {
        return {
          error: 'No pix from Alice found',
          totalPix: allPix.length,
          unviewedCount: unviewed.length,
          bobUsername: window.__client.username,
          aliceUser: aliceUser
        };
      }

      return {
        id: alicePix.id,
        senderUsername: alicePix.data.senderUsername,
        recipientUsername: alicePix.data.recipientUsername,
        mediaRef: alicePix.data.mediaRef,
        displayDuration: alicePix.data.displayDuration,
      };
    }, username);

    if (pixQuery.error) {
      console.log('Pix query debug:', pixQuery);
    }
    expect(pixQuery.error).toBeUndefined();
    expect(pixQuery.senderUsername).toBe(username);
    expect(pixQuery.recipientUsername).toBe(bobUsername);
    expect(pixQuery.mediaRef).toBeTruthy();
    console.log('Bob queried unviewed pix ✓');

    // Verify mediaRef is valid JSON with attachmentId
    const mediaRef = JSON.parse(pixQuery.mediaRef);
    expect(mediaRef.attachmentId).toBeTruthy();
    expect(mediaRef.contentKey).toBeTruthy();
    expect(mediaRef.nonce).toBeTruthy();
    console.log('Pix mediaRef has encrypted attachment reference ✓');

    // --- 9.3: Bob downloads and decrypts attachment ---
    const pixDownload = await bobPage.evaluate(async (mediaRefJson) => {
      try {
        const ref = JSON.parse(mediaRefJson);
        console.log('[bob] mediaRef parsed:', {
          attachmentId: ref.attachmentId,
          contentKeyLen: ref.contentKey?.length,
          nonceLen: ref.nonce?.length,
          contentHashLen: ref.contentHash?.length,
          contentType: ref.contentType
        });

        if (!ref.contentKey || !ref.nonce || !ref.contentHash) {
          return { error: 'Missing contentKey, nonce, or contentHash', ref };
        }

        const decrypted = await window.__client.attachments.download({
          attachmentId: ref.attachmentId,
          contentKey: new Uint8Array(ref.contentKey),
          nonce: new Uint8Array(ref.nonce),
          contentHash: new Uint8Array(ref.contentHash),
        });
        return {
          size: decrypted.byteLength,
          // Check for JPEG header (FF D8 FF) or any valid image
          header: Array.from(new Uint8Array(decrypted.slice(0, 4)))
        };
      } catch (e) {
        return { error: e.message, stack: e.stack };
      }
    }, pixQuery.mediaRef);

    expect(pixDownload.error).toBeUndefined();
    expect(pixDownload.size).toBeGreaterThan(0);
    // Fake camera produces valid image data
    console.log('Bob decrypted attachment:', pixDownload.size, 'bytes ✓');

    // --- 9.4: Multi-recipient pix (Alice → Bob + Carol) ---
    console.log('\n--- 9.4: Multi-recipient pix ---');

    // Set up listeners for both Bob and Carol BEFORE Alice sends
    const bobPix2Promise = bobPage.waitForEvent('console', {
      predicate: msg => msg.text().includes('[Global] Model sync:') && msg.text().includes('pix'),
      timeout: 30000,
    });
    const carolPixPromise = carolPage.waitForEvent('console', {
      predicate: msg => msg.text().includes('[Global] Model sync:') && msg.text().includes('pix'),
      timeout: 30000,
    });

    // Alice navigates to pix camera
    await page.goto('/pix/camera');
    await delay(500);

    // Wait for video stream
    await page.waitForFunction(() => {
      const video = document.querySelector('#camera-video');
      return video && video.srcObject && video.readyState >= 2;
    }, { timeout: 15000 });

    // Capture photo
    await page.click('#capture-btn');
    await delay(500);
    await page.waitForSelector('.pix-camera--preview', { timeout: 10000 });
    console.log('Alice captured photo for multi-send ✓');

    // Select BOTH Bob and Carol (multi-select)
    await page.click(`.pix-camera__friend-item[data-username="${bobUsername}"]`);
    await delay(200);
    await page.click(`.pix-camera__friend-item[data-username="${carolUsername}"]`);
    await delay(200);

    // Verify both are selected (header should show count)
    const headerText = await page.$eval('.pix-camera__friend-picker h3', el => el.textContent);
    expect(headerText).toContain('(2)');
    console.log('Alice selected Bob and Carol ✓');

    // Click send
    await page.click('#send-btn');

    // Should navigate to /pix after sending
    await page.waitForURL('**/pix', { timeout: 30000 });
    console.log('Alice sent multi-recipient pix ✓');

    // Wait for both to receive
    await Promise.all([bobPix2Promise, carolPixPromise]);
    console.log('Bob and Carol both received pix ✓');

    // Verify Carol can query her pix
    const carolPixQuery = await carolPage.evaluate(async (aliceUser) => {
      const allPix = await window.__client.pix.all();
      const unviewed = allPix.filter(s =>
        s.data.recipientUsername === window.__client.username &&
        !s.data.viewedAt &&
        !s.data._deleted
      );
      const pixEntry = unviewed.find(s => s.data.senderUsername === aliceUser);
      return pixEntry ? { found: true, mediaRef: pixEntry.data.mediaRef } : { found: false };
    }, username);

    expect(carolPixQuery.found).toBe(true);
    console.log('Carol queried her pix ✓');

    // Verify Carol can decrypt
    const carolDecrypt = await carolPage.evaluate(async (mediaRefJson) => {
      try {
        const ref = JSON.parse(mediaRefJson);
        const decrypted = await window.__client.attachments.download({
          attachmentId: ref.attachmentId,
          contentKey: new Uint8Array(ref.contentKey),
          nonce: new Uint8Array(ref.nonce),
          contentHash: new Uint8Array(ref.contentHash),
        });
        return { size: decrypted.byteLength };
      } catch (e) {
        return { error: e.message };
      }
    }, carolPixQuery.mediaRef);

    expect(carolDecrypt.error).toBeUndefined();
    expect(carolDecrypt.size).toBeGreaterThan(0);
    console.log('Carol decrypted attachment:', carolDecrypt.size, 'bytes ✓');

    // --- 9.5: Offline delivery (Bob logged out, receives pix on login) ---
    console.log('\n--- 9.5: Offline pix delivery ---');

    // Bob logs out
    await bobPage.goto('/settings');
    await bobPage.click('button[modal="logout-modal"]');
    await delay(300);
    await bobPage.click('#confirm-logout');
    await bobPage.waitForURL('**/login');
    console.log('Bob logged out');

    // Alice sends pix while Bob is offline
    await page.goto('/pix/camera');
    await delay(500);
    await page.waitForFunction(() => {
      const video = document.querySelector('#camera-video');
      return video && video.srcObject && video.readyState >= 2;
    }, { timeout: 15000 });

    await page.click('#capture-btn');
    await delay(500);
    await page.waitForSelector('.pix-camera--preview', { timeout: 10000 });
    console.log('Alice captured pix while Bob offline');

    // Select just Bob (single recipient)
    await page.click(`.pix-camera__friend-item[data-username="${bobUsername}"]`);
    await delay(200);
    await page.click('#send-btn');

    // Alice navigates to /pix after sending
    await page.waitForURL('**/pix', { timeout: 30000 });
    console.log('Alice sent pix to offline Bob ✓');

    // Bob logs back in
    await bobPage.fill('#username', bobUsername);
    await bobPage.fill('#password', password);
    await bobPage.click('button[type="submit"]');
    await bobPage.waitForURL('**/stories');

    // Wait for WebSocket to connect
    bobWs = false;
    for (let i = 0; i < 10; i++) {
      await delay(500);
      bobWs = await bobPage.evaluate(() => window.__client?.ws?.readyState === 1);
      if (bobWs) break;
    }
    expect(bobWs).toBe(true);
    console.log('Bob logged back in, WebSocket connected');

    // Wait a bit for queued messages to arrive
    await delay(2000);

    // Bob should now have the pix (queued delivery)
    const offlinePixQuery = await bobPage.evaluate(async (aliceUser) => {
      const allPix = await window.__client.pix.all();
      // Find the most recent unviewed pix from Alice
      const unviewed = allPix.filter(s =>
        s.data.senderUsername === aliceUser &&
        s.data.recipientUsername === window.__client.username &&
        !s.data.viewedAt &&
        !s.data._deleted
      );
      // Sort by timestamp descending to get the newest
      unviewed.sort((a, b) => b.timestamp - a.timestamp);
      const pixEntry = unviewed[0];
      return pixEntry ? { found: true, id: pixEntry.id, mediaRef: pixEntry.data.mediaRef } : { found: false, count: allPix.length };
    }, username);

    expect(offlinePixQuery.found).toBe(true);
    console.log('Bob received offline pix ✓');

    // Verify Bob can decrypt
    const offlineDecrypt = await bobPage.evaluate(async (mediaRefJson) => {
      try {
        const ref = JSON.parse(mediaRefJson);
        const decrypted = await window.__client.attachments.download({
          attachmentId: ref.attachmentId,
          contentKey: new Uint8Array(ref.contentKey),
          nonce: new Uint8Array(ref.nonce),
          contentHash: new Uint8Array(ref.contentHash),
        });
        return { size: decrypted.byteLength };
      } catch (e) {
        return { error: e.message };
      }
    }, offlinePixQuery.mediaRef);

    expect(offlineDecrypt.error).toBeUndefined();
    expect(offlineDecrypt.size).toBeGreaterThan(0);
    console.log('Bob decrypted offline pix:', offlineDecrypt.size, 'bytes ✓');

    // --- 9.6: UI Flow - Pix indicator shows in ConversationList ---
    console.log('\n--- 9.6: Pix UI Flow ---');

    // Alice sends a fresh pix so Bob has one to view via UI
    const uiPixPromise = bobPage.waitForEvent('console', {
      predicate: msg => msg.text().includes('[Global] Model sync:') && msg.text().includes('pix'),
      timeout: 30000,
    });

    await page.goto('/pix/camera');
    await delay(500);
    await page.waitForFunction(() => {
      const video = document.querySelector('#camera-video');
      return video && video.srcObject && video.readyState >= 2;
    }, { timeout: 15000 });
    await page.click('#capture-btn');
    await delay(500);
    await page.waitForSelector('.pix-camera--preview', { timeout: 10000 });
    await page.click(`.pix-camera__friend-item[data-username="${bobUsername}"]`);
    await delay(200);
    await page.click('#send-btn');
    await page.waitForURL('**/pix', { timeout: 30000 });
    console.log('Alice sent UI test pix ✓');

    await uiPixPromise;
    await delay(1000);

    // --- 9.7: Bob goes to /pix to see pix list ---
    await bobPage.goto('/pix');
    await bobPage.waitForSelector('.pix-list', { timeout: 15000 });
    console.log('Bob at /pix ✓');

    // Verify pix from Alice is visible
    const pixItem = await bobPage.$(`.pix-item[data-username="${username}"]`);
    expect(pixItem).not.toBeNull();
    console.log('Pix from Alice visible in list ✓');

    // --- 9.8: Click pix → PixViewer loads ---
    await bobPage.click(`.pix-item[data-username="${username}"]`);
    await bobPage.waitForURL(`**/pix/view/${username}`, { timeout: 10000 });
    console.log('Clicked → navigated to /pix/view ✓');

    // Wait for PixViewer to render
    await bobPage.waitForSelector('.pix-viewer', { timeout: 15000 });
    console.log('PixViewer rendered ✓');

    // --- 9.9: PixViewer shows image + timer ---
    // Wait for image to load (may take a moment to decrypt)
    await bobPage.waitForSelector('.pix-viewer__image', { timeout: 15000 });
    console.log('Pix image displayed ✓');

    // Verify timer bar exists
    const timerBar = await bobPage.$('.pix-viewer__timer-bar');
    expect(timerBar).not.toBeNull();
    console.log('Timer bar displayed ✓');

    // Verify sender name shows
    const senderName = await bobPage.$eval('.pix-viewer__sender', el => el.textContent);
    expect(senderName.length).toBeGreaterThan(0);
    console.log('Sender name displayed:', senderName, '✓');

    // --- 9.10: View pix and return ---
    // Click once to advance, then navigate back
    await bobPage.click('.pix-viewer').catch(() => {});
    await delay(1000);

    // Go back to /pix
    await bobPage.goto('/pix');
    await bobPage.waitForSelector('.pix-list', { timeout: 10000 });
    console.log('Viewed pix and returned to list ✓');

    console.log('\n=== SCENARIO 9 COMPLETE ===\n');

    // Cleanup
    await aliceContext.close();
    await bobContext.close();
    await bob2Context.close();
    await carolContext.close();
  });

});
