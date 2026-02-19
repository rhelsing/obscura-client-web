/**
 * Scenario 20: Audio Messages
 *
 * Tests: Press-and-hold mic button to record audio, send audio message
 *
 * Setup: Alice + Bob become friends
 * Alice records and sends an audio message to Bob
 */
import { test, expect } from '@playwright/test';
import { TEST_PASSWORD } from './helpers.js';

const delay = (ms = 300) => new Promise(r => setTimeout(r, ms));

function randomUsername() {
  return 'test_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
}

test.describe('Scenario 20: Audio Messages', () => {

  test('audio message recording and sending', async ({ browser }) => {
    test.setTimeout(180000);

    // Need to grant microphone permissions
    const aliceContext = await browser.newContext({
      permissions: ['microphone'],
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
    const password = TEST_PASSWORD;

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
    // TEST 1: Navigate to chat and verify mic button exists
    // ============================================================
    console.log('--- Test 1: Chat has mic button ---');

    await page.goto(`/messages/${bobUsername}`);
    await page.waitForSelector('.view.chat', { timeout: 10000 });

    const micBtn = await page.$('#mic-btn');
    expect(micBtn).not.toBeNull();
    console.log('Mic button found');

    // ============================================================
    // TEST 2: Press and hold to record audio
    // ============================================================
    console.log('--- Test 2: Record audio message ---');

    // Wait a moment for the page to settle
    await delay(500);

    // Get mic button position
    const micBtnBox = await page.locator('#mic-btn').boundingBox();
    if (!micBtnBox) throw new Error('Mic button not found');

    const centerX = micBtnBox.x + micBtnBox.width / 2;
    const centerY = micBtnBox.y + micBtnBox.height / 2;

    // Mouse down to start recording
    await page.mouse.move(centerX, centerY);
    await page.mouse.down();

    // Wait for recording to start
    await delay(500);

    // Check for recording indicator
    const recordingIndicator = await page.$('.recording-indicator');
    expect(recordingIndicator).not.toBeNull();
    console.log('Recording indicator visible');

    // Record for 2 seconds
    await delay(2000);

    // Mouse up to stop recording
    await page.mouse.up();

    // Wait for recording to process and send
    await delay(1000);

    console.log('Audio recorded and sent');

    // ============================================================
    // TEST 3: Verify audio message appears in chat
    // ============================================================
    console.log('--- Test 3: Audio message in chat ---');

    // Check for audio element in messages
    const audioElement = await page.$('.attachment-audio');
    expect(audioElement).not.toBeNull();
    console.log('Audio element displayed in chat');

    // ============================================================
    // TEST 4: Bob receives audio message
    // ============================================================
    console.log('--- Test 4: Bob receives audio ---');

    // Navigate Bob to the chat
    await bobPage.goto(`/messages/${username}`);
    await bobPage.waitForSelector('.view.chat', { timeout: 10000 });

    // Wait for message to sync and download
    // The attachment handler fires on the 'attachment' event which should show the message
    await delay(2000);

    // Wait for audio element to appear (may need time to download)
    try {
      await bobPage.waitForSelector('.attachment-audio, .attachment-loading, .attachment', { timeout: 10000 });
      const bobAudio = await bobPage.$('.attachment-audio, .attachment-loading, .attachment');
      expect(bobAudio).not.toBeNull();
      console.log('Bob received audio message');
    } catch (e) {
      // Check what's in the messages container
      const messagesHtml = await bobPage.$eval('#messages', el => el.innerHTML);
      console.log('Messages container:', messagesHtml.slice(0, 500));
      throw e;
    }

    console.log('\n=== SCENARIO 20 COMPLETE ===\n');

    await aliceContext.close();
    await bobContext.close();
  });
});
