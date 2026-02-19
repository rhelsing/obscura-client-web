/**
 * Scenario 11: Media Auto-Download + Cache Persistence
 *
 * Tests:
 * - Media auto-downloads on index (no "Load Media" button)
 * - IndexedDB cache survives logout
 * - Show view loads from cache instantly
 *
 * Flow:
 * 1. Alice + Bob become friends
 * 2. Bob logs out
 * 3. Alice posts story with image, then logs out
 * 4. Alice logs back in → image loads from IndexedDB cache
 * 5. Bob logs back in → image auto-downloads + caches
 * 6. Both click into story detail → image loads instantly from cache
 */
import { test, expect } from '@playwright/test';
import { TEST_PASSWORD } from './helpers.js';

const delay = (ms = 300) => new Promise(r => setTimeout(r, ms));

function randomUsername() {
  return 'test_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
}

/**
 * Create a small test image as a Buffer (1x1 red pixel PNG)
 */
function createTestImageBuffer() {
  const pngBytes = new Uint8Array([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
    0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
    0x08, 0x02, 0x00, 0x00, 0x00, 0x90, 0x77, 0x53,
    0xde, 0x00, 0x00, 0x00, 0x0c, 0x49, 0x44, 0x41,
    0x54, 0x08, 0xd7, 0x63, 0xf8, 0xcf, 0xc0, 0x00,
    0x00, 0x00, 0x03, 0x00, 0x01, 0x00, 0x05, 0xfe,
    0xd4, 0xaa, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45,
    0x4e, 0x44, 0xae, 0x42, 0x60, 0x82
  ]);
  return Buffer.from(pngBytes);
}

test.describe('Scenario 11: Media Auto-Download + Cache Persistence', () => {

  test('media auto-downloads and cache survives logout', async ({ browser }) => {
    test.setTimeout(240000); // 4 minutes

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

    const aliceUsername = randomUsername();
    const bobUsername = randomUsername();
    const password = TEST_PASSWORD;

    // --- Register Alice ---
    await page.goto('/register');
    await page.waitForSelector('#username', { timeout: 30000 });
    await page.fill('#username', aliceUsername);
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
    await bobPage.click(`.accept-btn[data-username="${aliceUsername}"]`);
    await delay(500);
    await aliceRespPromise;
    console.log('Alice and Bob are friends');

    console.log('\n=== SETUP COMPLETE ===\n');

    // ============================================================
    // PHASE 1: Bob logs out, Alice posts, Alice logs out
    // ============================================================
    console.log('--- Phase 1: Post while Bob offline ---');

    // Bob logs out (open drawer, click logout)
    await bobPage.goto('/stories');
    await bobPage.waitForSelector('button[drawer="more-drawer"]', { timeout: 10000 });
    await bobPage.click('button[drawer="more-drawer"]');
    await delay(300);
    await bobPage.waitForSelector('#logout-btn', { timeout: 5000 });
    await bobPage.click('#logout-btn');
    await bobPage.waitForURL('**/login', { timeout: 10000 });
    console.log('Bob logged out');

    // Alice posts story with image
    await page.goto('/stories/new');
    await page.waitForSelector('#add-media-btn', { timeout: 10000 });

    const [fileChooser] = await Promise.all([
      page.waitForEvent('filechooser'),
      page.click('#add-media-btn')
    ]);

    const testImageBuffer = createTestImageBuffer();
    await fileChooser.setFiles({
      name: 'test-image.png',
      mimeType: 'image/png',
      buffer: testImageBuffer,
    });

    await page.waitForSelector('#media-preview:not(.hidden)', { timeout: 5000 });
    await page.fill('#content', 'Story posted while Bob was offline');
    await page.click('button[type="submit"]');
    await page.waitForURL('**/stories', { timeout: 10000 });
    console.log('Alice posted story with image');

    // Verify Alice sees image immediately after posting
    await page.waitForSelector('.story-card', { timeout: 10000 });
    await page.waitForSelector('.story-card img', { timeout: 15000 });
    const aliceStoryCard = await page.$('.story-card');
    const aliceImg = await aliceStoryCard.$('img');
    expect(aliceImg).not.toBeNull();
    console.log('Alice sees image immediately after posting');

    // Get the story ID for later
    const storyId = await aliceStoryCard.getAttribute('data-id');
    console.log('Story ID:', storyId);

    // CRITICAL TEST: Alice refreshes page - blob URL would be stale, but cache-on-upload saves us
    console.log('--- Alice refreshes page (testing cache-on-upload) ---');
    await page.reload();
    await page.waitForSelector('.story-card', { timeout: 10000 });
    await page.waitForSelector('.story-card img', { timeout: 15000 });
    const aliceImgAfterRefresh = await page.$('.story-card img');
    expect(aliceImgAfterRefresh).not.toBeNull();
    const aliceImgSrcAfterRefresh = await aliceImgAfterRefresh.getAttribute('src');
    expect(aliceImgSrcAfterRefresh.startsWith('blob:')).toBe(true);
    console.log('Alice: Image loads after refresh (cache-on-upload worked!)');

    // Alice logs out (open drawer, click logout)
    await page.waitForSelector('button[drawer="more-drawer"]', { timeout: 10000 });
    await page.click('button[drawer="more-drawer"]');
    await delay(300);
    await page.waitForSelector('#logout-btn', { timeout: 5000 });
    await page.click('#logout-btn');
    await page.waitForURL('**/login', { timeout: 10000 });
    console.log('Alice logged out');

    console.log('\n=== PHASE 1 COMPLETE ===\n');

    // ============================================================
    // PHASE 2: Both log back in, verify auto-download
    // ============================================================
    console.log('--- Phase 2: Both log back in ---');

    // Alice logs back in
    await page.goto('/login');
    await page.waitForSelector('#username', { timeout: 10000 });
    await page.fill('#username', aliceUsername);
    await page.fill('#password', password);
    await page.click('button[type="submit"]');
    await page.waitForURL('**/stories', { timeout: 30000 });
    console.log('Alice logged back in');

    // Wait for WebSocket
    for (let i = 0; i < 10; i++) {
      await delay(500);
      aliceWs = await page.evaluate(() => window.__client?.ws?.readyState === 1);
      if (aliceWs) break;
    }

    // Alice should see image from IndexedDB cache (no "Load Media" button)
    await page.waitForSelector('.story-card', { timeout: 10000 });
    const aliceStoryCardAfterLogin = await page.$('.story-card');

    // ASSERTION: No "Load Media" button for Alice
    const aliceLoadBtn = await aliceStoryCardAfterLogin.$('.load-media-btn');
    expect(aliceLoadBtn).toBeNull();
    console.log('Alice: No "Load Media" button (loaded from IndexedDB cache)');

    // ASSERTION: Image is displayed
    const aliceImgAfterLogin = await aliceStoryCardAfterLogin.$('img');
    expect(aliceImgAfterLogin).not.toBeNull();
    const aliceImgSrc = await aliceImgAfterLogin.getAttribute('src');
    expect(aliceImgSrc.startsWith('blob:')).toBe(true);
    console.log('Alice: Image displayed with blob URL');

    // Bob logs back in
    await bobPage.goto('/login');
    await bobPage.waitForSelector('#username', { timeout: 10000 });
    await bobPage.fill('#username', bobUsername);
    await bobPage.fill('#password', password);
    await bobPage.click('button[type="submit"]');
    await bobPage.waitForURL('**/stories', { timeout: 30000 });
    console.log('Bob logged back in');

    // Wait for WebSocket
    for (let i = 0; i < 10; i++) {
      await delay(500);
      bobWs = await bobPage.evaluate(() => window.__client?.ws?.readyState === 1);
      if (bobWs) break;
    }

    // Wait for story to sync to Bob
    await delay(2000);

    // Bob navigates to stories
    await bobPage.goto('/stories');
    await bobPage.waitForSelector('.story-card', { timeout: 15000 });
    const bobStoryCard = await bobPage.$('.story-card');
    expect(bobStoryCard).not.toBeNull();
    console.log('Bob sees story card');

    // ASSERTION: No "Load Media" button for Bob (auto-downloaded)
    // Wait for auto-download to complete
    await bobPage.waitForSelector('.story-card img', { timeout: 15000 });
    const bobLoadBtn = await bobStoryCard.$('.load-media-btn');
    expect(bobLoadBtn).toBeNull();
    console.log('Bob: No "Load Media" button (auto-downloaded)');

    // ASSERTION: Image is displayed
    const bobImg = await bobPage.$('.story-card img');
    expect(bobImg).not.toBeNull();
    const bobImgSrc = await bobImg.getAttribute('src');
    expect(bobImgSrc.startsWith('blob:')).toBe(true);
    console.log('Bob: Image displayed with blob URL');

    console.log('\n=== PHASE 2 COMPLETE ===\n');

    // ============================================================
    // PHASE 3: Show view loads from cache
    // ============================================================
    console.log('--- Phase 3: Show view uses cache ---');

    // Alice clicks into story detail
    await page.click(`.story-card[data-id="${storyId}"]`);
    await page.waitForURL(`**/stories/${storyId}`, { timeout: 10000 });
    console.log('Alice navigated to story detail');

    // Wait for image to auto-load
    await page.waitForSelector('.story-media img', { timeout: 15000 });

    // ASSERTION: No "Load Media" button on detail view
    const aliceDetailLoadBtn = await page.$('#load-media-btn');
    expect(aliceDetailLoadBtn).toBeNull();
    console.log('Alice detail: No "Load Media" button');

    // ASSERTION: Image is displayed
    const aliceDetailImg = await page.$('.story-media img');
    expect(aliceDetailImg).not.toBeNull();
    const aliceDetailImgSrc = await aliceDetailImg.getAttribute('src');
    expect(aliceDetailImgSrc.startsWith('blob:')).toBe(true);
    console.log('Alice detail: Image displayed from cache');

    // Bob clicks into story detail
    const bobStoryId = await bobPage.$eval('.story-card', el => el.getAttribute('data-id'));
    await bobPage.click(`.story-card[data-id="${bobStoryId}"]`);
    await bobPage.waitForURL(`**/stories/${bobStoryId}`, { timeout: 10000 });
    console.log('Bob navigated to story detail');

    // Wait for image to auto-load
    await bobPage.waitForSelector('.story-media img', { timeout: 15000 });

    // ASSERTION: No "Load Media" button on detail view
    const bobDetailLoadBtn = await bobPage.$('#load-media-btn');
    expect(bobDetailLoadBtn).toBeNull();
    console.log('Bob detail: No "Load Media" button');

    // ASSERTION: Image is displayed
    const bobDetailImg = await bobPage.$('.story-media img');
    expect(bobDetailImg).not.toBeNull();
    const bobDetailImgSrc = await bobDetailImg.getAttribute('src');
    expect(bobDetailImgSrc.startsWith('blob:')).toBe(true);
    console.log('Bob detail: Image displayed from cache');

    console.log('\n=== SCENARIO 11 COMPLETE ===\n');

    // Cleanup
    await aliceContext.close();
    await bobContext.close();
  });
});
