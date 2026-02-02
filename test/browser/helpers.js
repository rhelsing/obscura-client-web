/**
 * Test Helpers for Browser E2E Tests
 * Provides utilities for robust test execution
 */

/**
 * Wait for the app view to be fully mounted and ready
 * @param {Page} page - Playwright page
 * @param {number} extraDelay - Additional delay in ms after ready (default 100)
 * @param {number} timeout - Max wait time in ms (default 10000)
 */
export async function waitForViewReady(page, extraDelay = 100, timeout = 10000) {
  await page.waitForFunction(() => window.__viewReady === true, { timeout });
  if (extraDelay > 0) {
    await page.waitForTimeout(extraDelay);
  }
}

/**
 * Navigate to a path and wait for the view to be ready
 * @param {Page} page - Playwright page
 * @param {string} path - Path to navigate to
 * @param {number} extraDelay - Additional delay in ms after ready (default 100)
 */
export async function gotoAndWait(page, path, extraDelay = 100) {
  await page.goto(path);
  await waitForViewReady(page, extraDelay);
}

/**
 * Common delay helper
 * @param {number} ms - Milliseconds to delay
 */
export const delay = (ms = 300) => new Promise(r => setTimeout(r, ms));

/**
 * Generate a random test username
 * @returns {string}
 */
export function randomUsername() {
  return 'test_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
}
