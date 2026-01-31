import { test, expect } from '@playwright/test';

test('Add Friend page shows no error on load', async ({ page }) => {
  await page.goto('/register');
  
  const username = 'test_' + Math.random().toString(36).slice(2, 10);
  await page.fill('#username', username);
  await page.fill('#password', 'testpass123');
  await page.click('button[type="submit"]');
  
  await page.waitForURL(/\/(friends|chats|home)/);
  
  await page.goto('/friends/add');
  await page.waitForSelector('h2:has-text("Add Someone")');
  
  const pageContent = await page.textContent('body');
  console.log('Page content:', pageContent);
  
  expect(pageContent).not.toContain('[object Object]');
  
  const errorAlert = page.locator('ry-alert[type="danger"]');
  await expect(errorAlert).not.toBeVisible();
});
