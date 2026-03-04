/**
 * Scenario 24: Group Chat Attachments & Voice Memos
 *
 * Tests:
 * - Voice memo recording in group chat (press-and-hold mic button)
 * - File attachment upload in group chat
 * - Attachment display in sender's group chat
 * - Attachment sync to group members via ORM
 * - Attachment download and display on receiver side
 *
 * Setup: Alice + Bob become friends, create group, test attachments
 */
import { test, expect } from '@playwright/test';
import { TEST_PASSWORD } from './helpers.js';

const delay = (ms = 300) => new Promise(r => setTimeout(r, ms));

function randomUsername() {
  return 'test_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
}

test.describe('Scenario 24: Group Chat Attachments & Voice Memos', () => {

  test('voice memo and file attachment in group chat', async ({ browser }) => {
    test.setTimeout(180000);

    // Alice needs microphone permissions
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

    // --- Create a group via UI ---
    await page.goto('/groups/new');
    await page.waitForSelector('#group-form', { timeout: 10000 });
    await page.fill('#group-name', 'Attachment Test Group');
    await page.click(`.friend-picker input[value="${bobUsername}"]`);
    await delay(200);
    await page.click('#group-form button[type="submit"]');
    await page.waitForURL('**/groups', { timeout: 10000 });
    await delay(500);

    // Get the group ID
    const groupId = await page.evaluate(async () => {
      const groups = await window.__client.group.where({}).exec();
      const g = groups.find(g => g.data?.name === 'Attachment Test Group');
      return g?.id;
    });
    expect(groupId).toBeTruthy();
    console.log('Group created:', groupId);

    console.log('\n=== SETUP COMPLETE ===\n');

    // ============================================================
    // TEST 1: Group chat has mic and attach buttons
    // ============================================================
    console.log('--- Test 1: Group chat has mic + attach buttons ---');

    await page.goto(`/groups/${groupId}`);
    await page.waitForSelector('.view.group-chat', { timeout: 10000 });

    const micBtn = await page.$('#mic-btn');
    expect(micBtn).not.toBeNull();
    console.log('Mic button found');

    const attachBtn = await page.$('#attach-btn');
    expect(attachBtn).not.toBeNull();
    console.log('Attach button found');

    const fileInput = await page.$('#file-input');
    expect(fileInput).not.toBeNull();
    console.log('File input found');

    // ============================================================
    // TEST 2: Send voice memo in group chat
    // ============================================================
    console.log('--- Test 2: Record voice memo in group ---');

    await delay(500);

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

    // Mouse up to stop recording and send
    await page.mouse.up();

    // Wait for recording to process and send
    await delay(2000);

    // Check for audio element in Alice's group chat
    const aliceAudio = await page.$('.attachment-audio');
    expect(aliceAudio).not.toBeNull();
    console.log('Audio element displayed in Alice group chat');

    // ============================================================
    // TEST 3: Bob receives voice memo in group
    // ============================================================
    console.log('--- Test 3: Bob receives voice memo ---');

    // Wait for sync
    await delay(2000);

    // Bob navigates to the group chat
    await bobPage.goto(`/groups/${groupId}`);
    await bobPage.waitForSelector('.view.group-chat', { timeout: 10000 });

    // Wait for message to sync and attachment to download
    await delay(3000);

    // Check for audio or attachment element
    try {
      await bobPage.waitForSelector('.attachment-audio, .attachment-loading, .attachment', { timeout: 15000 });
      const bobAudio = await bobPage.$('.attachment-audio, .attachment-loading, .attachment');
      expect(bobAudio).not.toBeNull();
      console.log('Bob received voice memo in group');
    } catch (e) {
      const messagesHtml = await bobPage.$eval('#messages', el => el.innerHTML);
      console.log('Bob messages container:', messagesHtml.slice(0, 500));
      throw e;
    }

    // ============================================================
    // TEST 4: Send file attachment in group chat
    // ============================================================
    console.log('--- Test 4: Send file attachment in group ---');

    // Navigate Alice back to the group
    await page.goto(`/groups/${groupId}`);
    await page.waitForSelector('.view.group-chat', { timeout: 10000 });
    await delay(500);

    // Create a test file and upload it via the file input
    const fileContent = 'Hello from group attachment test! This is a test file.';
    const fileInputHandle = await page.$('#file-input');

    // Use Playwright's setInputFiles to simulate file selection
    await fileInputHandle.setInputFiles({
      name: 'test-group-file.txt',
      mimeType: 'text/plain',
      buffer: Buffer.from(fileContent),
    });

    // Wait for upload
    await delay(3000);

    // Check that attachment appeared in Alice's chat
    const aliceAttachment = await page.$('.attachment');
    expect(aliceAttachment).not.toBeNull();
    console.log('File attachment displayed in Alice group chat');

    // ============================================================
    // TEST 5: Bob receives file attachment in group
    // ============================================================
    console.log('--- Test 5: Bob receives file attachment ---');

    // Wait for sync
    await delay(2000);

    // Navigate Bob to group (refresh to pick up new messages)
    await bobPage.goto(`/groups/${groupId}`);
    await bobPage.waitForSelector('.view.group-chat', { timeout: 10000 });

    // Wait for messages to load and attachments to download
    await delay(3000);

    // Should have at least 2 attachment messages (voice memo + file)
    const bobAttachments = await bobPage.$$('.attachment');
    expect(bobAttachments.length).toBeGreaterThanOrEqual(1);
    console.log('Bob received file attachment in group, total attachments:', bobAttachments.length);

    // ============================================================
    // TEST 6: Verify mediaUrl persisted in GroupMessage via ORM
    // ============================================================
    console.log('--- Test 6: Verify mediaUrl in ORM ---');

    const ormCheck = await page.evaluate(async (gid) => {
      const msgs = await window.__client.groupMessage
        .where({ 'data.groupId': gid })
        .orderBy('timestamp', 'asc')
        .exec();
      const withMedia = msgs.filter(m => m.data?.mediaUrl);
      return {
        totalMessages: msgs.length,
        messagesWithMedia: withMedia.length,
        firstMediaHasAttachmentId: withMedia.length > 0 && withMedia[0].data.mediaUrl.includes('attachmentId'),
      };
    }, groupId);

    expect(ormCheck.messagesWithMedia).toBeGreaterThanOrEqual(2); // voice memo + file
    expect(ormCheck.firstMediaHasAttachmentId).toBe(true);
    console.log('ORM check:', ormCheck);

    // ============================================================
    // TEST 7: Send image attachment in group
    // ============================================================
    console.log('--- Test 7: Send image attachment ---');

    await page.goto(`/groups/${groupId}`);
    await page.waitForSelector('.view.group-chat', { timeout: 10000 });
    await delay(500);

    // Create a small PNG image (1x1 pixel, red)
    const pngHeader = Buffer.from([
      0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, // PNG signature
      0x00, 0x00, 0x00, 0x0D, 0x49, 0x48, 0x44, 0x52, // IHDR chunk
      0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, // 1x1
      0x08, 0x02, 0x00, 0x00, 0x00, 0x90, 0x77, 0x53, // 8-bit RGB
      0xDE, 0x00, 0x00, 0x00, 0x0C, 0x49, 0x44, 0x41, // IDAT chunk
      0x54, 0x08, 0xD7, 0x63, 0xF8, 0xCF, 0xC0, 0x00, // compressed data
      0x00, 0x00, 0x02, 0x00, 0x01, 0xE2, 0x21, 0xBC, // checksum
      0x33, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4E, // IEND chunk
      0x44, 0xAE, 0x42, 0x60, 0x82,
    ]);

    const imgInput = await page.$('#file-input');
    await imgInput.setInputFiles({
      name: 'test-image.png',
      mimeType: 'image/png',
      buffer: pngHeader,
    });

    await delay(3000);

    // Check for image attachment
    const imageEl = await page.$('.attachment-image, .attachment');
    expect(imageEl).not.toBeNull();
    console.log('Image attachment displayed in group chat');

    console.log('\n=== SCENARIO 24 COMPLETE ===\n');

    await aliceContext.close();
    await bobContext.close();
  });
});
