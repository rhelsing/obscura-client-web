/**
 * Scenario 19: Video Recording in Pix Camera
 *
 * Tests: Press-and-hold to record video, video preview, video upload
 *
 * Setup: Alice + Bob become friends
 * Alice records a video pix and sends to Bob
 */
import { test, expect } from '@playwright/test';

const delay = (ms = 300) => new Promise(r => setTimeout(r, ms));

function randomUsername() {
  return 'test_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
}

test.describe('Scenario 19: Video Recording', () => {

  test('video pix recording and sending', async ({ browser }) => {
    test.setTimeout(180000); // 3 minutes

    // Need to grant camera/mic permissions
    const aliceContext = await browser.newContext({
      permissions: ['camera', 'microphone'],
    });
    const bobContext = await browser.newContext();

    const page = await aliceContext.newPage();
    const bobPage = await bobContext.newPage();

    page.on('dialog', d => d.accept());
    bobPage.on('dialog', d => d.accept());
    page.on('console', msg => console.log('[alice]', msg.text()));
    bobPage.on('console', msg => console.log('[bob]', msg.text()));

    const username = randomUsername();
    const bobUsername = randomUsername();
    const password = 'testpass123';

    // --- Register Alice ---
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
    console.log('Alice registered + connected');

    // --- Register Bob ---
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
    console.log('Bob registered + connected');

    // --- Make Alice and Bob friends ---
    await bobPage.goto('/friends/add');
    await bobPage.waitForSelector('#my-link-input');
    const bobLink = await bobPage.inputValue('#my-link-input');

    const bobReqPromise = bobPage.waitForEvent('console', {
      predicate: msg => msg.text().includes('Friend request from:'),
      timeout: 30000,
    });

    await page.goto('/friends/add');
    await page.waitForSelector('#friend-link');
    await page.fill('#friend-link', bobLink);
    await page.click('button[type="submit"]');
    await delay(300);
    await page.waitForSelector('#done-btn', { timeout: 15000 });

    await bobReqPromise;
    await delay(500);

    await bobPage.goto('/friends');
    await bobPage.waitForSelector('.friend-item.pending', { timeout: 15000 });

    const aliceRespPromise = page.waitForEvent('console', {
      predicate: msg => msg.text().includes('Friend response:'),
      timeout: 30000,
    });
    await bobPage.click(`.accept-btn[data-username="${username}"]`);
    await delay(500);
    await aliceRespPromise;
    console.log('Alice and Bob are friends');

    console.log('\n=== SETUP COMPLETE ===\n');

    // ============================================================
    // TEST 1: Navigate to pix camera and verify hint text
    // ============================================================
    console.log('--- Test 1: Camera UI shows video hint ---');

    await page.goto('/pix/camera');
    await page.waitForSelector('.pix-camera', { timeout: 10000 });

    // Verify hint text is present
    const hint = await page.$eval('.pix-camera__hint', el => el.textContent);
    expect(hint).toContain('hold for video');
    console.log('Hint text shows:', hint);

    // ============================================================
    // TEST 2: Tap for photo (quick press)
    // ============================================================
    console.log('--- Test 2: Quick tap captures photo ---');

    // Wait for camera to initialize
    await delay(1000);

    // Quick click (under 300ms threshold)
    const captureBtn = await page.$('#capture-btn');
    await captureBtn.click();

    // Should go to preview mode with image
    await page.waitForSelector('.pix-camera--preview', { timeout: 10000 });
    const previewImg = await page.$('.pix-camera__preview-image');
    expect(previewImg).not.toBeNull();
    console.log('Photo captured - preview shows image');

    // Cancel to go back
    await page.click('#cancel-btn');
    await page.waitForSelector('.pix-camera__capture-btn', { timeout: 5000 });
    console.log('Cancelled photo, back to camera');

    // ============================================================
    // TEST 3: Hold for video recording
    // ============================================================
    console.log('--- Test 3: Hold to record video ---');

    // Wait for camera to reinitialize
    await delay(1000);

    // Hold the capture button for 2 seconds (well over threshold)
    const captureBtnBox = await page.locator('#capture-btn').boundingBox();
    if (!captureBtnBox) throw new Error('Capture button not found');

    const centerX = captureBtnBox.x + captureBtnBox.width / 2;
    const centerY = captureBtnBox.y + captureBtnBox.height / 2;

    // Mouse down to start recording
    await page.mouse.move(centerX, centerY);
    await page.mouse.down();

    // Wait for recording to start (>300ms threshold)
    await delay(500);

    // Check for recording indicator
    const recordingIndicator = await page.$('.pix-camera__recording-indicator');
    expect(recordingIndicator).not.toBeNull();
    console.log('Recording indicator visible');

    // Record for 2 more seconds
    await delay(2000);

    // Mouse up to stop recording
    await page.mouse.up();

    // Should go to preview mode with video
    await page.waitForSelector('.pix-camera--preview', { timeout: 10000 });
    const previewVideo = await page.$('.pix-camera__preview-video');
    expect(previewVideo).not.toBeNull();
    console.log('Video captured - preview shows video element');

    // ============================================================
    // TEST 4: Send video pix to Bob
    // ============================================================
    console.log('--- Test 4: Send video pix ---');

    // Set up Bob's listener for pix sync
    const bobPixPromise = bobPage.waitForEvent('console', {
      predicate: msg => msg.text().includes('[Global] Model sync:') && msg.text().includes('pix'),
      timeout: 60000,
    });

    // Navigate Bob to /pix first
    await bobPage.goto('/pix');
    await bobPage.waitForSelector('.pix-list', { timeout: 10000 });

    // Select Bob as recipient
    await page.click(`.pix-camera__friend-item[data-username="${bobUsername}"]`);
    await delay(200);

    // Click send
    await page.click('#send-btn');

    // Wait for navigation to /pix (success indicator)
    await page.waitForURL('**/pix', { timeout: 60000 });
    console.log('Video pix sent');

    // ============================================================
    // TEST 5: Bob receives video pix
    // ============================================================
    console.log('--- Test 5: Bob receives video pix ---');

    await bobPixPromise;
    console.log('Bob received pix via modelSync');

    // Verify Bob can see the pix
    const bobPix = await bobPage.evaluate(async (aliceUser) => {
      const allPix = await window.__client.pix.all();
      return allPix.filter(p => p.data.senderUsername === aliceUser);
    }, username);

    expect(bobPix.length).toBeGreaterThan(0);
    console.log('Bob has pix from Alice');

    // Check content type is video
    const mediaRef = JSON.parse(bobPix[0].data.mediaRef);
    expect(mediaRef.contentType).toBe('video/webm');
    console.log('Content type is video/webm');

    // ============================================================
    // TEST 6: Bob sees purple indicator for video pix
    // ============================================================
    console.log('--- Test 6: Purple indicator for video ---');

    // Bob should see a pix-item with purple indicator (video)
    await bobPage.waitForSelector('.pix-item', { timeout: 10000 });

    // Check the indicator is purple (video color)
    const indicatorColor = await bobPage.$eval('.pix-indicator svg rect, .pix-indicator svg path', el => el.getAttribute('fill') || el.getAttribute('stroke'));
    console.log('Indicator color:', indicatorColor);
    // Purple should contain #9333ea or purple-500
    expect(indicatorColor).toContain('9333ea');
    console.log('Purple indicator shown for video pix');

    // ============================================================
    // TEST 7: Bob opens and views video pix
    // ============================================================
    console.log('--- Test 7: Bob views video pix ---');

    // Click to view
    await bobPage.click('.pix-item');

    // Should navigate to pix viewer
    await bobPage.waitForSelector('.pix-viewer', { timeout: 10000 });
    console.log('Bob opened pix viewer');

    // Wait for media to load and verify video element appears (not image)
    await delay(2000);
    const videoElement = await bobPage.$('.pix-viewer__video');
    const imageElement = await bobPage.$('.pix-viewer__image');

    if (!videoElement) {
      // Debug: show what's in the viewer
      const viewerHtml = await bobPage.$eval('.pix-viewer__content', el => el.innerHTML);
      console.log('Viewer content:', viewerHtml.slice(0, 500));
    }

    expect(videoElement).not.toBeNull();
    expect(imageElement).toBeNull(); // Should NOT have image element for video
    console.log('Video element rendered correctly (not img)');

    console.log('\n=== SCENARIO 19 COMPLETE ===\n');

    await aliceContext.close();
    await bobContext.close();
  });
});
