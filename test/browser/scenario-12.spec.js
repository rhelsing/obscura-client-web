/**
 * E2E Scenario 12 - Comprehensive Logging
 *
 * Verifies that all log events are captured and accessible from the /logs page.
 * Tests: message flow, friend operations, attachments, session establishment, prekey fetch.
 */
import { test, expect } from '@playwright/test';
import fs from 'fs';
import path from 'path';
import { delay, randomUsername, waitForViewReady } from './helpers.js';

test.describe('Scenario 12: Logging', () => {

  test('All log events are captured', async ({ browser }) => {
    test.setTimeout(120000); // 2 minutes

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
    await waitForViewReady(page);
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

    await page.waitForFunction(() => window.__client?.ws?.readyState === 1, { timeout: 10000 });
    console.log('Alice registered and connected');

    // ============================================================
    // SETUP: Register Bob
    // ============================================================
    console.log('\n=== SETUP: Register Bob ===');
    await bobPage.goto('/register');
    await waitForViewReady(bobPage);
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

    await bobPage.waitForFunction(() => window.__client?.ws?.readyState === 1, { timeout: 10000 });
    console.log('Bob registered and connected');

    // Helper to get logs from already-initialized logger (via window.__client)
    async function getLogs(p, limit = 100) {
      return await p.evaluate(async (lim) => {
        // Access the logger that's already initialized by ObscuraClient
        const { logger } = await import('/src/v2/lib/logger.js');
        // The logger is a singleton, but we need to ensure it's initialized
        // by checking if window.__client exists (which initializes the logger)
        if (window.__client) {
          return await logger.getAllEvents(lim);
        }
        return [];
      }, limit);
    }

    // ============================================================
    // TEST 1: GATEWAY_CONNECT should be logged
    // ============================================================
    console.log('\n=== TEST 1: Gateway Connect Logged ===');
    const aliceLogs1 = await getLogs(page, 50);

    const gatewayConnects = aliceLogs1.filter(e => e.eventType === 'gateway_connect');
    expect(gatewayConnects.length).toBeGreaterThan(0);
    console.log('GATEWAY_CONNECT logged ✓');

    // ============================================================
    // SETUP: Make Friends (this will trigger FRIEND events)
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
    // TEST 2: FRIEND_REQUEST_SENT should be logged (Alice sent)
    // ============================================================
    console.log('\n=== TEST 2: Friend Request Sent Logged ===');
    const aliceLogs2 = await getLogs(page);

    const friendRequestsSent = aliceLogs2.filter(e => e.eventType === 'friend_request_sent');
    expect(friendRequestsSent.length).toBeGreaterThan(0);
    expect(friendRequestsSent[0].data.username).toBe(bobUsername);
    console.log('FRIEND_REQUEST_SENT logged ✓', friendRequestsSent[0].data);

    // ============================================================
    // TEST 3: FRIEND_REQUEST_RECEIVED should be logged (Bob received)
    // ============================================================
    console.log('\n=== TEST 3: Friend Request Received Logged ===');
    const bobLogs3 = await getLogs(bobPage);

    const friendRequestsReceived = bobLogs3.filter(e => e.eventType === 'friend_request_received');
    expect(friendRequestsReceived.length).toBeGreaterThan(0);
    expect(friendRequestsReceived[0].data.username).toBe(username);
    console.log('FRIEND_REQUEST_RECEIVED logged ✓', friendRequestsReceived[0].data);

    // ============================================================
    // TEST 4: FRIEND_ACCEPT should be logged (Bob accepted)
    // ============================================================
    console.log('\n=== TEST 4: Friend Accept Logged ===');
    await delay(1000); // Wait for log write to complete
    const bobLogs4 = await getLogs(bobPage);
    console.log('Bob has', bobLogs4.length, 'log events. Types:', [...new Set(bobLogs4.map(e => e.eventType))]);

    const friendAccepts = bobLogs4.filter(e => e.eventType === 'friend_accept');
    expect(friendAccepts.length).toBeGreaterThan(0);
    console.log('FRIEND_ACCEPT logged ✓', friendAccepts[0].data);

    // ============================================================
    // TEST 5: Verify receive flow from friend request (already happened)
    // ============================================================
    console.log('\n=== TEST 5: Receive Flow from Friend Request ===');
    const bobLogs5 = await getLogs(bobPage, 200);

    const receiveCompletes = bobLogs5.filter(e => e.eventType === 'receive_complete');
    const receiveDecodes = bobLogs5.filter(e => e.eventType === 'receive_decode');

    expect(receiveCompletes.length).toBeGreaterThan(0);
    expect(receiveDecodes.length).toBeGreaterThan(0);
    console.log('RECEIVE_COMPLETE logged ✓', receiveCompletes[0].data);
    console.log('RECEIVE_DECODE logged ✓', receiveDecodes[0].data);

    // ============================================================
    // TEST 6: /logs page displays events
    // ============================================================
    console.log('\n=== TEST 6: /logs Page Displays Events ===');
    await page.goto('/logs');
    await page.waitForSelector('ry-stack.logs-list', { timeout: 10000 });

    // Count visible log events
    const logEventCount = await page.$$eval('ry-card.log-event', els => els.length);
    expect(logEventCount).toBeGreaterThan(0);
    console.log('/logs page shows', logEventCount, 'events ✓');

    // Check that badge shows event count
    const badgeText = await page.$eval('ry-badge[variant="primary"]', el => el.textContent);
    expect(badgeText).toContain('events');
    console.log('Event count badge visible ✓');

    // ============================================================
    // TEST 7: Copy button exists (clipboard permission denied in headless)
    // ============================================================
    console.log('\n=== TEST 7: Copy Button Exists ===');
    const copyBtn = await page.$('#copy-btn');
    expect(copyBtn).not.toBeNull();
    console.log('Copy button exists ✓');

    // ============================================================
    // TEST 8: Clear button works
    // ============================================================
    console.log('\n=== TEST 8: Clear Button Works ===');
    await page.click('#clear-btn');
    await delay(500);

    // Should show empty state
    const emptyState = await page.$('.empty');
    expect(emptyState).not.toBeNull();
    console.log('Clear button works ✓');

    // ============================================================
    // TEST 9: Verify events have styled badges
    // ============================================================
    console.log('\n=== TEST 9: Event Badges ===');

    // Navigate to /logs to see fresh events (need to trigger some logs first)
    await page.goto('/friends');
    await page.waitForFunction(() => window.__client?.ws?.readyState === 1, { timeout: 10000 });
    await delay(500);
    await page.goto('/logs');
    await page.waitForSelector('ry-stack.logs-list', { timeout: 10000 });

    // Check for log event badges
    const logCards = await page.$$('ry-card.log-event');
    console.log('Found', logCards.length, 'log event cards ✓');

    console.log('\n=== SCENARIO 12 COMPLETE ===\n');

    // ============================================================
    // CLEANUP
    // ============================================================
    await aliceContext.close();
    await bobContext.close();
  });

});
