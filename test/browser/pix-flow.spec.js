/**
 * Pix Flow Test - Full test for pix send/receive with streak
 */
import { test, expect } from '@playwright/test';
import { TEST_PASSWORD } from './helpers.js';

const delay = (ms = 300) => new Promise(r => setTimeout(r, ms));

function randomUsername() {
  return 'pix_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6);
}

// Helper to send a pix via camera UI
async function sendPix(senderPage, recipientUsername) {
  await senderPage.goto('/pix/camera');
  await delay(300);

  // Wait for camera
  await senderPage.waitForFunction(() => {
    const video = document.querySelector('#camera-video');
    return video && video.srcObject && video.readyState >= 2;
  }, { timeout: 15000 });

  // Capture
  await senderPage.click('#capture-btn');
  await delay(300);
  await senderPage.waitForSelector('.pix-camera--preview', { timeout: 10000 });

  // Select recipient
  await senderPage.click(`.pix-camera__friend-item[data-username="${recipientUsername}"]`);
  await delay(200);

  // Send
  await senderPage.click('#send-btn');
  await senderPage.waitForURL('**/pix', { timeout: 30000 });
}

test('Pix: Alice and Bob exchange 3 pix each, streak shows', async ({ browser }) => {
  test.setTimeout(180000); // 3 minutes

  const aliceContext = await browser.newContext();
  const bobContext = await browser.newContext();
  const alicePage = await aliceContext.newPage();
  const bobPage = await bobContext.newPage();

  alicePage.on('console', msg => console.log('[alice]', msg.text()));
  bobPage.on('console', msg => console.log('[bob]', msg.text()));

  const aliceUsername = randomUsername();
  const bobUsername = randomUsername();
  const password = TEST_PASSWORD;

  // ========== REGISTER ALICE ==========
  console.log('\n--- Registering Alice ---');
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
  await alicePage.waitForURL('**/stories', { timeout: 30000 });
  console.log('Alice registered ✓');

  // Wait for WebSocket
  for (let i = 0; i < 10; i++) {
    await delay(500);
    const ws = await alicePage.evaluate(() => window.__client?.ws?.readyState === 1);
    if (ws) break;
  }

  // ========== REGISTER BOB ==========
  console.log('\n--- Registering Bob ---');
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
  await bobPage.waitForURL('**/stories', { timeout: 30000 });
  console.log('Bob registered ✓');

  // Wait for WebSocket
  for (let i = 0; i < 10; i++) {
    await delay(500);
    const ws = await bobPage.evaluate(() => window.__client?.ws?.readyState === 1);
    if (ws) break;
  }

  // ========== MAKE FRIENDS PROGRAMMATICALLY ==========
  console.log('\n--- Making friends ---');

  // Get Bob's userId
  const bobUserId = await bobPage.evaluate(() => window.__client.userId);
  console.log('Bob userId:', bobUserId);

  // Set up listeners before friend request
  const bobReqPromise = bobPage.waitForEvent('console', {
    predicate: msg => msg.text().includes('Friend request from:'),
    timeout: 15000,
  });
  const aliceRespPromise = alicePage.waitForEvent('console', {
    predicate: msg => msg.text().includes('Friend response:'),
    timeout: 15000,
  });

  // Alice sends friend request
  await alicePage.evaluate(async ({ oderId, bobUser }) => {
    await window.__client.befriend(oderId, bobUser);
  }, { oderId: bobUserId, bobUser: bobUsername });
  console.log('Alice sent friend request');

  await bobReqPromise;
  console.log('Bob received friend request');

  // Bob accepts via UI
  await bobPage.goto('/friends');
  await bobPage.waitForSelector('.friend-item.pending', { timeout: 15000 });
  console.log('Bob sees pending request');

  await bobPage.click(`.accept-btn[data-username="${aliceUsername}"]`);
  await delay(500);
  console.log('Bob accepted');

  await aliceRespPromise;
  console.log('Friends established ✓');
  await delay(500);

  // ========== NAVIGATE RECEIVERS TO /pix BEFORE SENDING ==========
  console.log('\n--- Navigating Bob to /pix ---');
  await bobPage.goto('/pix');
  await bobPage.waitForSelector('.pix-list', { timeout: 10000 });
  console.log('Bob at /pix ✓');

  // ========== ALICE SENDS 3 PIX TO BOB ==========
  console.log('\n--- Alice sends 3 pix to Bob ---');

  for (let i = 1; i <= 3; i++) {
    console.log(`Sending pix ${i}/3 from Alice to Bob...`);
    await sendPix(alicePage, bobUsername);
    console.log(`Alice sent pix ${i}/3 ✓`);
    await delay(500);
  }

  // ========== BOB SENDS 3 PIX TO ALICE ==========
  console.log('\n--- Bob sends 3 pix to Alice ---');

  for (let i = 1; i <= 3; i++) {
    console.log(`Sending pix ${i}/3 from Bob to Alice...`);
    await sendPix(bobPage, aliceUsername);
    console.log(`Bob sent pix ${i}/3 ✓`);
    await delay(500);
  }

  // ========== VERIFY STREAK SHOWS ==========
  console.log('\n--- Verifying streak shows ---');

  // Go to Alice's pix list and check for streak
  await alicePage.goto('/pix');
  await alicePage.waitForSelector('.pix-list', { timeout: 10000 });
  await delay(500);
  console.log('Alice at /pix');

  // Check for streak badge on Bob's entry
  const aliceStreakBadge = await alicePage.$('.streak-badge');
  const aliceStreakText = aliceStreakBadge ? await aliceStreakBadge.textContent() : null;
  console.log('Alice sees streak badge:', aliceStreakText);

  expect(aliceStreakBadge).not.toBeNull();
  expect(aliceStreakText).toContain('🔥');
  console.log('Alice sees streak badge ✓');

  // Go to Bob's pix list and check for streak
  await bobPage.goto('/pix');
  await bobPage.waitForSelector('.pix-list', { timeout: 10000 });
  await delay(500);
  console.log('Bob at /pix');

  // Check for streak badge on Alice's entry
  const bobStreakBadge = await bobPage.$('.streak-badge');
  const bobStreakText = bobStreakBadge ? await bobStreakBadge.textContent() : null;
  console.log('Bob sees streak badge:', bobStreakText);

  expect(bobStreakBadge).not.toBeNull();
  expect(bobStreakText).toContain('🔥');
  console.log('Bob sees streak badge ✓');

  // ========== BOB VIEWS ONE PIX ==========
  console.log('\n--- Bob views pix ---');

  // Bob clicks on Alice's entry to view pix
  await bobPage.click(`.pix-item[data-username="${aliceUsername}"]`);
  await bobPage.waitForURL(`**/pix/view/${aliceUsername}`, { timeout: 10000 });
  console.log('Navigated to pix viewer ✓');

  // Wait for pix viewer
  await bobPage.waitForSelector('.pix-viewer', { timeout: 15000 });
  console.log('Pix viewer rendered ✓');

  // Wait for image
  try {
    await bobPage.waitForSelector('.pix-viewer__image', { timeout: 10000 });
    console.log('Pix image displayed ✓');
  } catch (e) {
    console.log('Image not loaded within timeout');
  }

  // Click through to close
  try {
    await bobPage.click('.pix-viewer', { timeout: 3000 });
  } catch (e) {
    // Viewer may have already navigated away
  }
  await delay(500);

  // Navigate back to /pix
  if (!bobPage.url().endsWith('/pix')) {
    await bobPage.goto('/pix');
  }
  await bobPage.waitForSelector('.pix-list', { timeout: 10000 });
  console.log('Back at /pix ✓');

  // Verify streak still shows after viewing
  await delay(500);
  const streakAfterView = await bobPage.$('.streak-badge');
  expect(streakAfterView).not.toBeNull();
  console.log('Streak still shows after viewing pix ✓');

  console.log('\n=== PIX FLOW TEST COMPLETE ===\n');

  // Cleanup
  await aliceContext.close();
  await bobContext.close();
});
