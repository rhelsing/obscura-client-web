/**
 * E2E Scenario 5b - Cross-User Device Linking with Full SYNC_BLOB Verification
 *
 * Real-world bug: User logs in on browser where different user was previously logged in.
 * The old user's session in localStorage competes with new user's session.
 *
 * This test verifies SYNC_BLOB syncs EVERYTHING:
 *   - Friends list
 *   - Profile (displayName, bio)
 *   - Stories (both own and received from friends)
 *
 * Setup:
 *   1. Alice registers on Browser X (shared browser)
 *   2. Alice closes browser (stale session in localStorage)
 *   3. Bob registers on Browser Y
 *   4. Alice2 registers on Browser Z (fresh - for friending)
 *   5. Bob and Alice2 become friends
 *   6. Bob updates profile (displayName, bio)
 *   7. Bob posts a story
 *   8. Alice2 posts a story (Bob1 receives it)
 *   9. Bob2 logs in on Browser X (Alice's stale browser)
 *   10. Bob1 approves, Bob2 receives SYNC_BLOB
 *
 * Verify on Bob2:
 *   - Friends list: Alice2 is friend
 *   - Profile synced: displayName, bio
 *   - Bob's story synced
 *   - Alice2's story synced (was received by Bob1)
 *   - No 401 errors
 *   - Session is Bob's, not Alice's
 */
import { test, expect } from '@playwright/test';

const delay = (ms = 300) => new Promise(r => setTimeout(r, ms));

function randomUsername() {
  return 'test_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
}

test.describe('Scenario 5b: Cross-User Device Linking', () => {

  test('Bob2 links device with full SYNC_BLOB verification', async ({ browser }) => {
    test.setTimeout(240000); // 4 minutes

    // ============================================================
    // SETUP: Create browser contexts
    // Browser X = shared browser (Alice then Bob2)
    // Browser Y = Bob's original device
    // Browser Z = Alice2 (fresh, for friending)
    // ============================================================
    const sharedBrowserContext = await browser.newContext();  // Browser X
    const bobContext = await browser.newContext();            // Browser Y
    const alice2Context = await browser.newContext();         // Browser Z

    const password = 'testpass123';
    const aliceUsername = randomUsername();    // Stale user on shared browser
    const bobUsername = randomUsername();
    const alice2Username = randomUsername();   // Fresh Alice for friending

    // Track console errors for 401 detection
    const consoleErrors = [];

    // ============================================================
    // STEP 1: Alice registers on shared browser (Browser X)
    // ============================================================
    console.log('\n=== STEP 1: Alice registers on shared browser ===');
    const alicePage = await sharedBrowserContext.newPage();
    alicePage.on('dialog', dialog => dialog.accept());
    alicePage.on('console', msg => {
      console.log('[alice]', msg.text());
      if (msg.text().includes('401') || msg.text().includes('Unauthorized')) {
        consoleErrors.push(msg.text());
      }
    });

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

    let aliceWs = false;
    for (let i = 0; i < 10; i++) {
      await delay(500);
      aliceWs = await alicePage.evaluate(() => window.__client?.ws?.readyState === 1);
      if (aliceWs) break;
    }
    expect(aliceWs).toBe(true);
    console.log('Alice registered and connected on shared browser');

    // ============================================================
    // STEP 2: Alice closes browser WITHOUT proper logout
    // ============================================================
    console.log('\n=== STEP 2: Alice closes browser (stale session remains) ===');
    const aliceSession = await alicePage.evaluate(() => localStorage.getItem('obscura_session'));
    expect(aliceSession).not.toBeNull();
    console.log('Alice session in localStorage (stale data)');
    await alicePage.close();

    // ============================================================
    // STEP 3: Bob registers on Browser Y
    // ============================================================
    console.log('\n=== STEP 3: Bob registers on Browser Y ===');
    const bobPage = await bobContext.newPage();
    bobPage.on('dialog', dialog => dialog.accept());
    bobPage.on('console', msg => console.log('[bob]', msg.text()));

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
    // STEP 4: Alice2 registers on Browser Z (for friending)
    // ============================================================
    console.log('\n=== STEP 4: Alice2 registers on Browser Z ===');
    const alice2Page = await alice2Context.newPage();
    alice2Page.on('dialog', dialog => dialog.accept());
    alice2Page.on('console', msg => console.log('[alice2]', msg.text()));

    await alice2Page.goto('/register');
    await alice2Page.waitForSelector('#username', { timeout: 30000 });
    await alice2Page.fill('#username', alice2Username);
    await alice2Page.fill('#password', password);
    await alice2Page.fill('#confirm-password', password);
    await alice2Page.click('button[type="submit"]');
    await delay(300);

    await alice2Page.waitForSelector('.phrase-box', { timeout: 30000 });
    await alice2Page.check('#confirm-saved');
    await alice2Page.click('#continue-btn');
    await delay(300);
    await alice2Page.waitForURL('**/stories', { timeout: 30000 });

    let alice2Ws = false;
    for (let i = 0; i < 10; i++) {
      await delay(500);
      alice2Ws = await alice2Page.evaluate(() => window.__client?.ws?.readyState === 1);
      if (alice2Ws) break;
    }
    expect(alice2Ws).toBe(true);
    console.log('Alice2 registered and connected');

    // ============================================================
    // STEP 5: Bob and Alice2 become friends
    // ============================================================
    console.log('\n=== STEP 5: Bob and Alice2 become friends ===');

    // Get Alice2's friend link
    await alice2Page.goto('/friends/add');
    await alice2Page.waitForSelector('#my-link-input');
    const alice2Link = await alice2Page.inputValue('#my-link-input');

    // Set up promise for Alice2 to receive friend request
    const alice2ReqPromise = alice2Page.waitForEvent('console', {
      predicate: msg => msg.text().includes('Friend request from:'),
      timeout: 30000,
    });

    // Bob sends friend request to Alice2
    await bobPage.goto('/friends/add');
    await bobPage.waitForSelector('#friend-link');
    await bobPage.fill('#friend-link', alice2Link);
    await bobPage.click('button[type="submit"]');
    await delay(300);
    await bobPage.waitForSelector('#done-btn', { timeout: 15000 });

    // Wait for Alice2 to receive request
    await alice2ReqPromise;
    await delay(500);

    // Alice2 accepts Bob's request
    await alice2Page.goto('/friends');
    await alice2Page.waitForSelector('.friend-item.pending', { timeout: 15000 });

    const bobRespPromise = bobPage.waitForEvent('console', {
      predicate: msg => msg.text().includes('Friend response:'),
      timeout: 30000,
    });
    await alice2Page.click(`.accept-btn[data-username="${bobUsername}"]`);
    await delay(500);
    await bobRespPromise;
    console.log('Bob and Alice2 are friends');

    // ============================================================
    // STEP 6: Bob updates profile
    // ============================================================
    console.log('\n=== STEP 6: Bob updates profile ===');
    await bobPage.goto('/profile/edit');
    await bobPage.waitForSelector('#profile-form', { timeout: 10000 });
    await bobPage.fill('#display-name', 'Bob Test');
    await bobPage.fill('#bio', 'Hello from Bob!');
    await bobPage.click('button[type="submit"]');
    await bobPage.waitForURL('**/profile', { timeout: 10000 });
    console.log('Bob profile updated: displayName="Bob Test", bio="Hello from Bob!"');

    // ============================================================
    // STEP 7: Bob posts a story
    // ============================================================
    console.log('\n=== STEP 7: Bob posts a story ===');

    // Alice2 should receive it
    const alice2StoryPromise = alice2Page.waitForEvent('console', {
      predicate: msg => msg.text().includes('[Global] Model sync:') && msg.text().includes('story'),
      timeout: 15000,
    });

    await bobPage.evaluate(async () => {
      await window.__client.story.create({ content: "Bob's first story" });
    });

    await alice2StoryPromise;
    console.log('Bob posted story, Alice2 received it');

    // ============================================================
    // STEP 8: Alice2 posts a story (Bob1 receives it)
    // ============================================================
    console.log('\n=== STEP 8: Alice2 posts a story ===');

    const bobStoryPromise = bobPage.waitForEvent('console', {
      predicate: msg => msg.text().includes('[Global] Model sync:') && msg.text().includes('story'),
      timeout: 15000,
    });

    await alice2Page.evaluate(async () => {
      await window.__client.story.create({ content: "Alice2's story" });
    });

    await bobStoryPromise;
    console.log('Alice2 posted story, Bob1 received it');

    // Verify Bob1 has both stories
    const bob1Stories = await bobPage.evaluate(async () => {
      const stories = await window.__client.story.where({}).exec();
      return stories.map(s => s.data.content);
    });
    expect(bob1Stories).toContain("Bob's first story");
    expect(bob1Stories).toContain("Alice2's story");
    console.log('Bob1 has both stories:', bob1Stories);

    // ============================================================
    // STEP 9: Bob2 logs in on shared browser (Alice's former browser)
    // ============================================================
    console.log('\n=== STEP 9: Bob2 logs in on shared browser ===');
    const bob2Page = await sharedBrowserContext.newPage();
    bob2Page.on('dialog', dialog => dialog.accept());
    bob2Page.on('console', msg => {
      console.log('[bob2]', msg.text());
      if (msg.text().includes('401') || msg.text().includes('Unauthorized')) {
        consoleErrors.push(msg.text());
      }
    });

    await bob2Page.goto('/login');
    await bob2Page.waitForSelector('#username', { timeout: 10000 });
    await bob2Page.fill('#username', bobUsername);
    await bob2Page.fill('#password', password);
    await bob2Page.click('button[type="submit"]');
    await delay(300);

    // Should go to link-pending
    await bob2Page.waitForURL('**/link-pending', { timeout: 15000 });
    console.log('Bob2 redirected to /link-pending');

    // ============================================================
    // STEP 10: Get link code and Bob1 approves
    // ============================================================
    console.log('\n=== STEP 10: Bob1 approves Bob2 ===');
    await bob2Page.waitForSelector('.link-code', { timeout: 10000 });
    const bob2LinkCode = await bob2Page.$eval('.link-code', el => el.value || el.textContent);
    expect(bob2LinkCode.length).toBeGreaterThan(10);
    console.log('Bob2 link code captured');

    await bobPage.evaluate(async (code) => {
      await window.__client.approveLink(code);
      await window.__client.announceDevices();
    }, bob2LinkCode);
    console.log('Bob1 approved Bob2');

    // ============================================================
    // STEP 11: Bob2 receives SYNC_BLOB
    // ============================================================
    console.log('\n=== STEP 11: SYNC_BLOB received ===');
    await bob2Page.waitForURL('**/stories', { timeout: 20000 });

    let bob2Ws = false;
    for (let i = 0; i < 10; i++) {
      await delay(500);
      bob2Ws = await bob2Page.evaluate(() => window.__client?.ws?.readyState === 1);
      if (bob2Ws) break;
    }
    expect(bob2Ws).toBe(true);
    console.log('Bob2 connected after approval');

    // Wait for SYNC_BLOB to be fully processed
    await delay(1000);

    // ============================================================
    // VERIFICATIONS
    // ============================================================
    console.log('\n=== VERIFICATIONS ===');

    // Verify 1: Session is Bob's, not Alice's
    console.log('--- Verify 1: Correct user session ---');
    const bob2SessionUsername = await bob2Page.evaluate(() => window.__client?.username);
    expect(bob2SessionUsername).toBe(bobUsername);
    expect(bob2SessionUsername).not.toBe(aliceUsername);
    console.log(`Session is for "${bob2SessionUsername}" (correct)`);

    // Verify 2: No 401 errors
    console.log('--- Verify 2: No 401 errors ---');
    const has401Errors = consoleErrors.some(e => e.includes('401') || e.includes('Unauthorized'));
    expect(has401Errors).toBe(false);
    console.log(`No 401 errors (${consoleErrors.length} total)`);

    // Verify 3: Friends list synced
    console.log('--- Verify 3: Friends list synced ---');
    const bob2Friends = await bob2Page.evaluate(() => {
      return window.__client.friends.getAll().map(f => f.username);
    });
    expect(bob2Friends).toContain(alice2Username);
    console.log(`Bob2 friends: ${bob2Friends.join(', ')}`);

    // Verify 4: Profile synced
    console.log('--- Verify 4: Profile synced ---');
    const bob2Profile = await bob2Page.evaluate(async () => {
      // Query profiles from all own devices (same logic as ViewProfile.js)
      const ownDeviceIds = [
        window.__client.deviceUUID,
        ...window.__client.devices.getAll().map(d => d.deviceUUID || d.serverUserId)
      ];
      const allProfiles = await window.__client.profile.where({}).exec();
      const profile = allProfiles
        .filter(p => ownDeviceIds.includes(p.authorDeviceId))
        .sort((a, b) => b.timestamp - a.timestamp)[0];
      return profile?.data || null;
    });
    expect(bob2Profile).not.toBeNull();
    expect(bob2Profile.displayName).toBe('Bob Test');
    expect(bob2Profile.bio).toBe('Hello from Bob!');
    console.log('Bob2 profile:', bob2Profile);

    // Verify 5: Stories synced AND DISPLAYED
    console.log('--- Verify 5: Stories synced and displayed ---');

    // First verify data is in store
    const bob2Stories = await bob2Page.evaluate(async () => {
      const stories = await window.__client.story.where({}).exec();
      return stories.map(s => s.data.content);
    });
    expect(bob2Stories).toContain("Bob's first story");
    expect(bob2Stories).toContain("Alice2's story");
    console.log(`Bob2 stories in store: ${bob2Stories.join(', ')}`);

    // Now verify stories are DISPLAYED on the page
    await bob2Page.waitForSelector('.story-card', { timeout: 5000 });
    const displayedStories = await bob2Page.$$eval('.story-card p', els =>
      els.map(el => el.textContent)
    );
    expect(displayedStories).toContain("Bob's first story");
    expect(displayedStories).toContain("Alice2's story");
    console.log(`Bob2 stories displayed: ${displayedStories.join(', ')}`);

    // Verify 6: TTL cleanup removes old stories AND attachments
    console.log('--- Verify 6: TTL cleanup removes old stories and attachments ---');

    // Create a fake attachment and old story with mediaUrl
    const { oldStoryId, attachmentId } = await bob2Page.evaluate(async () => {
      const oldTimestamp = Date.now() - (25 * 60 * 60 * 1000); // 25 hours ago
      const testAttachmentId = 'test_attachment_' + Date.now();

      // Add fake attachment to cache
      if (window.__client._attachmentStore) {
        await window.__client._attachmentStore.put(testAttachmentId, new ArrayBuffer(100), {
          contentType: 'image/jpeg',
        });
      }

      // Create old story with mediaUrl pointing to attachment
      const story = {
        id: 'test_old_story_' + Date.now(),
        data: {
          content: 'Old expired story with image',
          mediaUrl: JSON.stringify({ attachmentId: testAttachmentId, contentKey: [], nonce: [] }),
        },
        timestamp: oldTimestamp,
        signature: new Uint8Array(0),
        authorDeviceId: window.__client.deviceUUID,
      };
      await window.__client.story.crdt.add(story);
      return { oldStoryId: story.id, attachmentId: testAttachmentId };
    });
    console.log(`Created old story: ${oldStoryId} with attachment: ${attachmentId}`);

    // Verify story and attachment exist before cleanup
    const beforeCleanup = await bob2Page.evaluate(async ({ storyId, attachId }) => {
      const stories = await window.__client.story.where({}).exec();
      const storyExists = stories.some(s => s.id === storyId);
      const attachExists = window.__client._attachmentStore
        ? await window.__client._attachmentStore.has(attachId)
        : false;
      return { storyExists, attachExists };
    }, { storyId: oldStoryId, attachId: attachmentId });
    expect(beforeCleanup.storyExists).toBe(true);
    expect(beforeCleanup.attachExists).toBe(true);
    console.log(`Before cleanup - Story exists: ${beforeCleanup.storyExists}, Attachment exists: ${beforeCleanup.attachExists}`);

    // Run TTL cleanup
    await bob2Page.evaluate(async () => {
      await window.__client._runTTLCleanup();
    });
    console.log('TTL cleanup executed');

    // Verify both are deleted
    const afterCleanup = await bob2Page.evaluate(async ({ storyId, attachId }) => {
      const stories = await window.__client.story.where({}).exec();
      const storyExists = stories.some(s => s.id === storyId);
      const attachExists = window.__client._attachmentStore
        ? await window.__client._attachmentStore.has(attachId)
        : false;
      return { storyExists, attachExists };
    }, { storyId: oldStoryId, attachId: attachmentId });
    expect(afterCleanup.storyExists).toBe(false);
    expect(afterCleanup.attachExists).toBe(false);
    console.log(`After cleanup - Story exists: ${afterCleanup.storyExists}, Attachment exists: ${afterCleanup.attachExists}`);

    // Verify fresh stories still exist
    const freshStoriesAfter = await bob2Page.evaluate(async () => {
      const stories = await window.__client.story.where({}).exec();
      return stories.map(s => s.data.content);
    });
    expect(freshStoriesAfter).toContain("Bob's first story");
    expect(freshStoriesAfter).toContain("Alice2's story");
    console.log(`Fresh stories preserved: ${freshStoriesAfter.join(', ')}`);

    console.log('\n=== SCENARIO 5b COMPLETE ===\n');

    // ============================================================
    // CLEANUP
    // ============================================================
    await bob2Page.close();
    await bobPage.close();
    await alice2Page.close();
    await sharedBrowserContext.close();
    await bobContext.close();
    await alice2Context.close();
  });

});
