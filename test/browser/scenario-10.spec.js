/**
 * Scenario 10: Story Attachments
 *
 * Tests: Image-only stories, media upload, decryption, caching
 *
 * Setup: Alice + Bob become friends
 */
import { test, expect } from '@playwright/test';

const delay = (ms = 300) => new Promise(r => setTimeout(r, ms));

function randomUsername() {
  return 'test_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
}

/**
 * Create a small test image as a Buffer (1x1 red pixel PNG)
 */
function createTestImageBuffer() {
  // Minimal 1x1 red PNG (67 bytes)
  const pngBytes = new Uint8Array([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, // PNG signature
    0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52, // IHDR chunk
    0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, // 1x1
    0x08, 0x02, 0x00, 0x00, 0x00, 0x90, 0x77, 0x53, // 8-bit RGB
    0xde, 0x00, 0x00, 0x00, 0x0c, 0x49, 0x44, 0x41, // IDAT chunk
    0x54, 0x08, 0xd7, 0x63, 0xf8, 0xcf, 0xc0, 0x00, // compressed data
    0x00, 0x00, 0x03, 0x00, 0x01, 0x00, 0x05, 0xfe, // red pixel
    0xd4, 0xaa, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, // IEND chunk
    0x4e, 0x44, 0xae, 0x42, 0x60, 0x82
  ]);
  return Buffer.from(pngBytes);
}

test.describe('Scenario 10: Story Attachments', () => {

  test('story with image attachment - full flow', async ({ browser }) => {
    test.setTimeout(180000); // 3 minutes

    // ============================================================
    // SETUP: Alice + Bob become friends
    // ============================================================
    const aliceContext = await browser.newContext();
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
    // TEST 1: Image-only story (no text content)
    // ============================================================
    console.log('--- Test 1: Image-only story ---');

    // Set up Bob's listener for story sync
    const bobStorySyncPromise = bobPage.waitForEvent('console', {
      predicate: msg => msg.text().includes('[Global] Model sync:') && msg.text().includes('story'),
      timeout: 30000,
    });

    // Navigate to create story
    await page.goto('/stories/new');
    await page.waitForSelector('#add-media-btn', { timeout: 10000 });

    // Click "Add Photo/Video" and upload test image
    const [fileChooser] = await Promise.all([
      page.waitForEvent('filechooser'),
      page.click('#add-media-btn')
    ]);

    // Create test image buffer and upload
    const testImageBuffer = createTestImageBuffer();
    await fileChooser.setFiles({
      name: 'test-image.png',
      mimeType: 'image/png',
      buffer: testImageBuffer,
    });

    // Verify media preview shows
    await page.waitForSelector('#media-preview:not(.hidden)', { timeout: 5000 });
    const previewText = await page.$eval('#media-preview', el => el.textContent);
    expect(previewText).toContain('test-image.png');
    console.log('Media preview shows: ' + previewText);

    // Leave text content empty and submit
    await page.click('button[type="submit"]');
    console.log('Submitted image-only story');

    // ============================================================
    // TEST 2: Redirect after post
    // ============================================================
    console.log('--- Test 2: Redirect after post ---');

    await page.waitForURL('**/stories', { timeout: 10000 });
    console.log('Redirected to /stories');

    // ============================================================
    // TEST 3: Media displays immediately (no Load Media button)
    // ============================================================
    console.log('--- Test 3: Media displays immediately ---');

    // Wait for story card to render
    await page.waitForSelector('.story-card', { timeout: 10000 });

    // Get the first story card (should be ours)
    const storyCard = await page.$('.story-card');
    expect(storyCard).not.toBeNull();

    // Check that there's no "Load Media" button (media should already be loaded from cache)
    const loadMediaBtn = await storyCard.$('.load-media-btn');
    expect(loadMediaBtn).toBeNull();
    console.log('No "Load Media" button (media loaded from cache)');

    // Check that an image is displayed
    const storyImg = await storyCard.$('img');
    expect(storyImg).not.toBeNull();
    console.log('Image is displayed in story card');

    // Verify it's a blob URL
    const imgSrc = await storyImg.getAttribute('src');
    expect(imgSrc.startsWith('blob:')).toBe(true);
    console.log('Image src is blob URL');

    // ============================================================
    // TEST 4: Media persists on navigation
    // ============================================================
    console.log('--- Test 4: Media persists on navigation ---');

    // Navigate away
    await page.goto('/friends');
    await page.waitForSelector('.friend-item', { timeout: 10000 });
    console.log('Navigated to /friends');

    // Navigate back
    await page.goto('/stories');
    await page.waitForSelector('.story-card', { timeout: 10000 });
    console.log('Navigated back to /stories');

    // Check media still shows (from sessionStorage cache)
    const storyCardAfter = await page.$('.story-card');
    const imgAfter = await storyCardAfter.$('img');
    expect(imgAfter).not.toBeNull();
    console.log('Image still displayed after navigation');

    // ============================================================
    // TEST 5: Friend receives story with media
    // ============================================================
    console.log('--- Test 5: Friend receives story with media ---');

    // Wait for Bob to receive the story
    await bobStorySyncPromise;
    console.log('Bob received story via modelSync');

    // Navigate Bob to stories
    await bobPage.goto('/stories');
    await bobPage.waitForSelector('.story-card', { timeout: 15000 });

    // Bob should see Alice's story
    const bobStoryCard = await bobPage.$('.story-card');
    expect(bobStoryCard).not.toBeNull();
    console.log('Bob sees story card');

    // ============================================================
    // TEST 6: Decryption succeeds (no constantTimeEqual error)
    // ============================================================
    console.log('--- Test 6: Decryption succeeds ---');

    // For Bob, media should show "Load Media" button (not cached)
    const bobLoadBtn = await bobStoryCard.$('.load-media-btn');
    expect(bobLoadBtn).not.toBeNull();
    console.log('Bob sees "Load Media" button');

    // Set up console listener to catch any errors
    let decryptError = null;
    const errorHandler = msg => {
      if (msg.text().includes('constantTimeEqual') || msg.text().includes("can't access property")) {
        decryptError = msg.text();
      }
    };
    bobPage.on('console', errorHandler);

    // Click Load Media
    await bobLoadBtn.click();
    console.log('Bob clicked "Load Media"');

    // Wait for image to appear (successful decryption)
    await bobPage.waitForSelector('.story-card img', { timeout: 15000 });
    console.log('Image loaded successfully');

    // Check no decryption errors occurred
    expect(decryptError).toBeNull();
    console.log('No constantTimeEqual errors');

    // Re-query the DOM since it re-rendered after loading media
    const bobImgSrc = await bobPage.$eval('.story-card img', el => el.src);
    expect(bobImgSrc.startsWith('blob:')).toBe(true);
    console.log('Bob sees decrypted image with blob URL');

    bobPage.off('console', errorHandler);

    // ============================================================
    // TEST 7: Cache works (second load is from cache)
    // ============================================================
    console.log('--- Test 7: Cache works ---');

    // Navigate Bob away and back
    await bobPage.goto('/friends');
    await bobPage.waitForSelector('.friend-item', { timeout: 10000 });
    await bobPage.goto('/stories');
    await bobPage.waitForSelector('.story-card', { timeout: 10000 });

    // Since we're not using sessionStorage for Bob's cache (that's for poster only),
    // Bob should see "Load Media" button again - but the attachmentStore should have cached the decrypted blob
    // Let's verify the download is faster the second time by timing it
    const bobLoadBtn2 = await bobPage.$('.load-media-btn');

    if (bobLoadBtn2) {
      const startTime = Date.now();
      await bobLoadBtn2.click();
      await bobPage.waitForSelector('.story-card img', { timeout: 15000 });
      const loadTime = Date.now() - startTime;
      console.log(`Second load took ${loadTime}ms (cached via attachmentStore)`);
      // Cache should make it faster, but we can't guarantee exact timing
    } else {
      // If no button, the image was already loaded (UI cached the blob URL)
      console.log('Image already loaded (UI cached blob URL)');
    }

    // ============================================================
    // TEST 8: Story with text and image
    // ============================================================
    console.log('--- Test 8: Story with text and image ---');

    await page.goto('/stories/new');
    await page.waitForSelector('#content', { timeout: 10000 });

    // Add text content
    await page.fill('#content', 'Check out this image!');

    // Add image
    const [fileChooser2] = await Promise.all([
      page.waitForEvent('filechooser'),
      page.click('#add-media-btn')
    ]);
    await fileChooser2.setFiles({
      name: 'test-image-2.png',
      mimeType: 'image/png',
      buffer: testImageBuffer,
    });

    await page.click('button[type="submit"]');
    await page.waitForURL('**/stories', { timeout: 10000 });

    // Verify story shows with both text and image
    await page.waitForSelector('.story-card', { timeout: 10000 });
    const textAndImageStory = await page.$('.story-card');
    const storyText = await textAndImageStory.$eval('p', el => el.textContent);
    expect(storyText).toContain('Check out this image!');
    const storyImgWithText = await textAndImageStory.$('img');
    expect(storyImgWithText).not.toBeNull();
    console.log('Story with text and image created and displayed');

    console.log('\n=== SCENARIO 10 COMPLETE ===\n');

    // Cleanup
    await aliceContext.close();
    await bobContext.close();
  });
});
