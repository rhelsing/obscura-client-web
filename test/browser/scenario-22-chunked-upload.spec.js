/**
 * Scenario 22: Chunked File Upload
 *
 * Tests: Large file upload (>950KB) using chunked transfer
 *
 * Setup: Alice + Bob become friends
 * Alice uploads a 2MB file, Bob receives and downloads it
 * Verifies: chunking, progress, integrity
 */
import { test, expect } from '@playwright/test';

const delay = (ms = 300) => new Promise(r => setTimeout(r, ms));

function randomUsername() {
  return 'test_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
}

// Generate a test file of specified size with verifiable content
function generateTestFile(sizeBytes) {
  const data = new Uint8Array(sizeBytes);
  // Fill with pattern that we can verify later
  for (let i = 0; i < sizeBytes; i++) {
    data[i] = i % 256;
  }
  return data;
}

test.describe('Scenario 22: Chunked File Upload', () => {

  test('2MB file upload and download', async ({ browser }) => {
    test.setTimeout(300000); // 5 minutes

    const aliceContext = await browser.newContext();
    const bobContext = await browser.newContext();

    const alicePage = await aliceContext.newPage();
    const bobPage = await bobContext.newPage();

    alicePage.on('dialog', d => d.accept());
    bobPage.on('dialog', d => d.accept());
    alicePage.on('console', msg => console.log('[alice]', msg.text()));
    bobPage.on('console', msg => console.log('[bob]', msg.text()));

    const aliceUsername = randomUsername();
    const bobUsername = randomUsername();
    const password = 'testpass123';

    // --- Register Alice ---
    console.log('=== Registering Alice ===');
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

    // Wait for WebSocket
    for (let i = 0; i < 10; i++) {
      await delay(500);
      const wsConnected = await alicePage.evaluate(() => window.__client?.ws?.readyState === 1);
      if (wsConnected) break;
    }
    console.log('Alice registered + connected');

    // --- Register Bob ---
    console.log('=== Registering Bob ===');
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

    // Wait for WebSocket
    for (let i = 0; i < 10; i++) {
      await delay(500);
      const wsConnected = await bobPage.evaluate(() => window.__client?.ws?.readyState === 1);
      if (wsConnected) break;
    }
    console.log('Bob registered + connected');

    // --- Make friends via link ---
    console.log('=== Making Alice and Bob friends ===');

    // Get Bob's friend link
    await bobPage.goto('/friends/add');
    await bobPage.waitForSelector('#my-link-input');
    const bobLink = await bobPage.inputValue('#my-link-input');

    // Wait for Bob to receive friend request
    const bobReqPromise = bobPage.waitForEvent('console', {
      predicate: msg => msg.text().includes('Friend request from:'),
      timeout: 30000,
    });

    // Alice sends friend request via Bob's link
    await alicePage.goto('/friends/add');
    await alicePage.waitForSelector('#friend-link');
    await alicePage.fill('#friend-link', bobLink);
    await alicePage.click('button[type="submit"]');
    await delay(300);
    await alicePage.waitForSelector('#done-btn', { timeout: 15000 });

    await bobReqPromise;
    await delay(500);

    // Bob accepts the request
    await bobPage.goto('/friends');
    await bobPage.waitForSelector('.friend-item.pending', { timeout: 15000 });
    await bobPage.click('.accept-btn');
    await delay(1000);

    // Wait for Alice to receive acceptance
    await alicePage.waitForEvent('console', {
      predicate: msg => msg.text().includes('Friend response:'),
      timeout: 15000,
    }).catch(() => {});
    await delay(500);

    console.log('Alice and Bob are friends');

    // --- Test 1: Upload 2MB file ---
    console.log('\n=== Test 1: Upload 2MB file ===');

    // Navigate Alice to chat with Bob
    await alicePage.goto(`/messages/${bobUsername}`);
    await alicePage.waitForSelector('.chat', { timeout: 30000 });
    await delay(500);

    // Generate 2MB test file (will require ~3 chunks)
    const testFileSize = 2 * 1024 * 1024; // 2MB
    const testData = generateTestFile(testFileSize);

    // Create file input and upload
    const fileInput = await alicePage.$('input[type="file"]');
    expect(fileInput).toBeTruthy();

    // Create a temporary file
    const [fileChooser] = await Promise.all([
      alicePage.waitForEvent('filechooser'),
      alicePage.click('#attach-btn'),
    ]);

    // Upload the file via buffer
    await fileChooser.setFiles({
      name: 'test-2mb.bin',
      mimeType: 'application/octet-stream',
      buffer: Buffer.from(testData),
    });

    console.log('File upload started');

    // Wait for upload to complete (watch for progress messages)
    let uploadComplete = false;
    for (let i = 0; i < 60; i++) {
      await delay(1000);
      const complete = await alicePage.evaluate(() => {
        const msgs = document.querySelectorAll('.message.sent');
        for (const msg of msgs) {
          // Check if there's a file download link or no progress bar
          const fileLink = msg.querySelector('.file-download');
          const progress = msg.querySelector('.attachment-progress');
          if (fileLink && !progress) return true;
        }
        return false;
      });
      if (complete) {
        uploadComplete = true;
        break;
      }
      // Log progress
      const progress = await alicePage.evaluate(() => {
        const progressEl = document.querySelector('.progress-text');
        return progressEl?.textContent || 'waiting...';
      });
      console.log('Upload progress:', progress);
    }

    expect(uploadComplete).toBe(true);
    console.log('Upload complete!');

    // --- Test 2: Bob receives and downloads ---
    console.log('\n=== Test 2: Bob receives chunked file ===');

    await bobPage.goto(`/messages/${aliceUsername}`);
    await bobPage.waitForSelector('.chat', { timeout: 30000 });
    await delay(2000);

    // Wait for message to appear and download
    let downloadComplete = false;
    for (let i = 0; i < 60; i++) {
      await delay(1000);

      const complete = await bobPage.evaluate(() => {
        const msgs = document.querySelectorAll('.message.received');
        for (const msg of msgs) {
          const fileLink = msg.querySelector('.file-download');
          const loading = msg.querySelector('.attachment-loading');
          if (fileLink && !loading) return true;
        }
        return false;
      });
      if (complete) {
        downloadComplete = true;
        break;
      }
      // Log progress
      const progress = await bobPage.evaluate(() => {
        const loadingEl = document.querySelector('.attachment-loading');
        return loadingEl?.textContent || 'waiting...';
      });
      console.log('Download progress:', progress);
    }

    expect(downloadComplete).toBe(true);
    console.log('Download complete!');

    // --- Test 3: Verify file integrity ---
    console.log('\n=== Test 3: Verify file integrity ===');

    // Get the downloaded file data URL
    const fileDataUrl = await bobPage.evaluate(() => {
      const link = document.querySelector('.file-download');
      return link?.dataset?.dataurl || null;
    });

    expect(fileDataUrl).toBeTruthy();
    expect(fileDataUrl.startsWith('data:')).toBe(true);

    // Verify file size by decoding data URL
    const fileSize = await bobPage.evaluate((dataUrl) => {
      // Extract base64 data and decode
      const base64 = dataUrl.split(',')[1];
      const binary = atob(base64);
      return binary.length;
    }, fileDataUrl);

    console.log(`Downloaded file size: ${fileSize} bytes (expected: ${testFileSize})`);
    expect(fileSize).toBe(testFileSize);

    // Verify content pattern (first and last bytes)
    const contentVerified = await bobPage.evaluate((dataUrl) => {
      const base64 = dataUrl.split(',')[1];
      const binary = atob(base64);
      // Check pattern: data[i] should be i % 256
      const first = binary.charCodeAt(0);
      const at1000 = binary.charCodeAt(1000);
      const last = binary.charCodeAt(binary.length - 1);
      return {
        first,
        at1000,
        last,
        expectedFirst: 0 % 256,
        expectedAt1000: 1000 % 256,
        expectedLast: (binary.length - 1) % 256,
      };
    }, fileDataUrl);

    console.log('Content verification:', contentVerified);
    expect(contentVerified.first).toBe(contentVerified.expectedFirst);
    expect(contentVerified.at1000).toBe(contentVerified.expectedAt1000);
    expect(contentVerified.last).toBe(contentVerified.expectedLast);

    // --- Test 4: Bob refreshes and file is still there ---
    console.log('\n=== Test 4: Bob refreshes page, file still loads ===');

    await bobPage.reload();
    await bobPage.waitForSelector('.chat', { timeout: 30000 });
    await delay(2000);

    // Wait for message to load from IndexedDB and download chunks
    let reloadDownloadComplete = false;
    for (let i = 0; i < 60; i++) {
      await delay(1000);

      const complete = await bobPage.evaluate(() => {
        const msgs = document.querySelectorAll('.message.received');
        for (const msg of msgs) {
          const fileLink = msg.querySelector('.file-download');
          const loading = msg.querySelector('.attachment-loading');
          const error = msg.querySelector('.attachment-error');
          if (error) return 'error';
          if (fileLink && !loading) return true;
        }
        return false;
      });
      if (complete === 'error') {
        console.log('ERROR: Attachment failed to load after refresh!');
        break;
      }
      if (complete) {
        reloadDownloadComplete = true;
        break;
      }
      const progress = await bobPage.evaluate(() => {
        const loadingEl = document.querySelector('.attachment-loading');
        return loadingEl?.textContent || 'waiting...';
      });
      console.log('Reload download progress:', progress);
    }

    expect(reloadDownloadComplete).toBe(true);
    console.log('File still loads after refresh!');

    // Verify integrity again after reload
    const reloadFileDataUrl = await bobPage.evaluate(() => {
      const link = document.querySelector('.file-download');
      return link?.dataset?.dataurl || null;
    });

    expect(reloadFileDataUrl).toBeTruthy();
    const reloadFileSize = await bobPage.evaluate((dataUrl) => {
      const base64 = dataUrl.split(',')[1];
      const binary = atob(base64);
      return binary.length;
    }, reloadFileDataUrl);

    console.log(`After reload - file size: ${reloadFileSize} bytes`);
    expect(reloadFileSize).toBe(testFileSize);

    // --- Test 5: Bob clicks download link ---
    console.log('\n=== Test 5: Bob clicks download link ===');

    // Set up download listener
    const [download] = await Promise.all([
      bobPage.waitForEvent('download'),
      bobPage.click('.file-download'),
    ]);

    // Get the downloaded file content
    const downloadPath = await download.path();
    const downloadedFileName = download.suggestedFilename();
    console.log(`Downloaded file: ${downloadedFileName}`);
    expect(downloadedFileName).toBe('test-2mb.bin');

    // Verify downloaded file size via stream
    const downloadStream = await download.createReadStream();
    const chunks = [];
    for await (const chunk of downloadStream) {
      chunks.push(chunk);
    }
    const downloadedContent = Buffer.concat(chunks);
    console.log(`Downloaded content size: ${downloadedContent.length} bytes`);
    expect(downloadedContent.length).toBe(testFileSize);
    console.log('Bob download click: VERIFIED');

    // --- Test 6: Alice (sender) refreshes and file still loads ---
    console.log('\n=== Test 6: Alice refreshes page, sent file still loads ===');

    await alicePage.reload();
    await alicePage.waitForSelector('.chat', { timeout: 30000 });
    await delay(2000);

    let aliceReloadComplete = false;
    for (let i = 0; i < 60; i++) {
      await delay(1000);

      const complete = await alicePage.evaluate(() => {
        const msgs = document.querySelectorAll('.message.sent');
        for (const msg of msgs) {
          const fileLink = msg.querySelector('.file-download');
          const loading = msg.querySelector('.attachment-loading');
          const error = msg.querySelector('.attachment-error');
          if (error) return 'error';
          if (fileLink && !loading) return true;
        }
        return false;
      });
      if (complete === 'error') {
        console.log('ERROR: Sender attachment failed to load after refresh!');
        break;
      }
      if (complete) {
        aliceReloadComplete = true;
        break;
      }
      const progress = await alicePage.evaluate(() => {
        const loadingEl = document.querySelector('.attachment-loading');
        return loadingEl?.textContent || 'waiting...';
      });
      console.log('Alice reload progress:', progress);
    }

    expect(aliceReloadComplete).toBe(true);
    console.log('Sender file still loads after refresh!');

    // --- Test 7: Alice clicks download link ---
    console.log('\n=== Test 7: Alice clicks download link ===');

    const [aliceDownload] = await Promise.all([
      alicePage.waitForEvent('download'),
      alicePage.click('.file-download'),
    ]);

    const aliceDownloadedFileName = aliceDownload.suggestedFilename();
    console.log(`Alice downloaded file: ${aliceDownloadedFileName}`);
    expect(aliceDownloadedFileName).toBe('test-2mb.bin');

    const aliceDownloadStream = await aliceDownload.createReadStream();
    const aliceChunks = [];
    for await (const chunk of aliceDownloadStream) {
      aliceChunks.push(chunk);
    }
    const aliceDownloadedContent = Buffer.concat(aliceChunks);
    console.log(`Alice downloaded content size: ${aliceDownloadedContent.length} bytes`);
    expect(aliceDownloadedContent.length).toBe(testFileSize);
    console.log('Alice download click: VERIFIED');

    console.log('\n=== SCENARIO 22 COMPLETE ===');
    console.log('Chunked upload/download verified:');
    console.log(`- File size: ${testFileSize} bytes (2MB)`);
    console.log(`- Chunks: ~${Math.ceil(testFileSize / (950 * 1024))}`);
    console.log('- Integrity: VERIFIED');
    console.log('- Receiver reload: VERIFIED');
    console.log('- Sender reload: VERIFIED');
    console.log('- Receiver download click: VERIFIED');
    console.log('- Sender download click: VERIFIED');

    await aliceContext.close();
    await bobContext.close();
  });

});
