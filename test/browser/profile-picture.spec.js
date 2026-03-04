/**
 * Profile Picture - Browser Integration Test
 *
 * Tests the avatar upload pipeline in a real browser:
 * 1. compressImage correctly compresses and resizes
 * 2. FileReader converts to data URL
 * 3. Preview updates in the DOM
 * 4. avatarUrl variable is set for form submission
 *
 * This test does NOT require a server - it tests the browser-side
 * pipeline in isolation using a generated test image.
 *
 * Run: npx playwright test test/browser/profile-picture.spec.js --headed
 */
import { test, expect } from '@playwright/test';

test.describe('Profile Picture Upload Pipeline', () => {

  test('compressImage resizes and compresses to target', async ({ page }) => {
    // Load a minimal page that has access to the compressImage function
    await page.goto('/');
    await page.waitForTimeout(500);

    const result = await page.evaluate(async () => {
      // Dynamically import compressImage from the app's module
      const { compressImage } = await import('/src/v2/lib/media.js');

      // Create a 500x500 test image using Canvas
      const canvas = document.createElement('canvas');
      canvas.width = 500;
      canvas.height = 500;
      const ctx = canvas.getContext('2d');
      // Draw a colorful gradient so JPEG compression has real content
      const gradient = ctx.createLinearGradient(0, 0, 500, 500);
      gradient.addColorStop(0, '#ff0000');
      gradient.addColorStop(0.5, '#00ff00');
      gradient.addColorStop(1, '#0000ff');
      ctx.fillStyle = gradient;
      ctx.fillRect(0, 0, 500, 500);
      ctx.fillStyle = '#ffffff';
      ctx.font = '48px sans-serif';
      ctx.fillText('TEST', 150, 270);

      const originalBlob = await new Promise(resolve =>
        canvas.toBlob(resolve, 'image/png')
      );

      // Compress with our profile picture settings: max 200px, max 50KB
      const compressed = await compressImage(originalBlob, 50 * 1024, 200);

      // Verify it's a Blob
      if (!(compressed instanceof Blob)) {
        return { error: 'compressImage did not return a Blob' };
      }

      // Check the compressed image dimensions by loading it
      const url = URL.createObjectURL(compressed);
      const img = new Image();
      await new Promise((resolve, reject) => {
        img.onload = resolve;
        img.onerror = reject;
        img.src = url;
      });
      URL.revokeObjectURL(url);

      // Convert to data URL to verify it's valid
      const reader = new FileReader();
      const dataUrl = await new Promise(resolve => {
        reader.onload = () => resolve(reader.result);
        reader.readAsDataURL(compressed);
      });

      return {
        originalSize: originalBlob.size,
        compressedSize: compressed.size,
        compressedType: compressed.type,
        width: img.naturalWidth,
        height: img.naturalHeight,
        dataUrlLength: dataUrl.length,
        dataUrlPrefix: dataUrl.slice(0, 30),
        isUnder50KB: compressed.size <= 50 * 1024,
        isMaxDimension200: Math.max(img.naturalWidth, img.naturalHeight) <= 200,
      };
    });

    console.log('compressImage result:', JSON.stringify(result, null, 2));

    expect(result.error).toBeUndefined();
    expect(result.compressedType).toBe('image/jpeg');
    expect(result.isMaxDimension200).toBe(true);
    expect(result.isUnder50KB).toBe(true);
    expect(result.width).toBeLessThanOrEqual(200);
    expect(result.height).toBeLessThanOrEqual(200);
    expect(result.dataUrlPrefix).toContain('data:image/jpeg;base64');
    expect(result.compressedSize).toBeLessThan(result.originalSize);

    console.log(`PASS: 500x500 PNG (${result.originalSize} bytes) → ${result.width}x${result.height} JPEG (${result.compressedSize} bytes)`);
    console.log(`Data URL length: ${result.dataUrlLength} chars`);
  });

  test('EditProfile avatar upload updates DOM preview', async ({ page }) => {
    await page.goto('/');
    await page.waitForTimeout(500);

    // Inject the EditProfile view into the page with a mock client
    const result = await page.evaluate(async () => {
      const { render, mount } = await import('/src/v2/views/profile/EditProfile.js');

      // Create a mock client
      const mockClient = {
        username: 'testuser',
        deviceUUID: 'device-1',
        devices: { getAll: () => [] },
        profile: {
          where: () => ({ exec: async () => [] }),
          create: async (data) => {
            // Capture what gets saved
            window.__savedProfileData = data;
            return { id: 'profile-1', data, timestamp: Date.now() };
          },
          upsert: async (id, data) => {
            window.__savedProfileData = data;
            return { id, data, timestamp: Date.now() };
          },
        },
      };

      // Mock router
      const mockRouter = { updatePageLinks: () => {} };

      // Mount the view
      const container = document.getElementById('app');
      await mount(container, mockClient, mockRouter);

      // Verify the view rendered
      const avatarSection = container.querySelector('.avatar-section');
      const changeBtn = container.querySelector('#change-avatar-btn');
      const avatarInput = container.querySelector('#avatar-input');
      const placeholder = container.querySelector('.avatar-placeholder');

      return {
        hasAvatarSection: !!avatarSection,
        hasChangeBtn: !!changeBtn,
        hasAvatarInput: !!avatarInput,
        hasPlaceholder: !!placeholder,
        placeholderText: placeholder?.textContent,
      };
    });

    console.log('EditProfile render result:', JSON.stringify(result, null, 2));
    expect(result.hasAvatarSection).toBe(true);
    expect(result.hasChangeBtn).toBe(true);
    expect(result.hasAvatarInput).toBe(true);
    expect(result.hasPlaceholder).toBe(true);
    expect(result.placeholderText).toBe('?');

    // Now simulate a file upload with a generated test image
    // Create a test PNG file and dispatch it to the file input
    const uploadResult = await page.evaluate(async () => {
      // Create a small test image
      const canvas = document.createElement('canvas');
      canvas.width = 400;
      canvas.height = 400;
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#3498db';
      ctx.fillRect(0, 0, 400, 400);
      ctx.fillStyle = '#ffffff';
      ctx.beginPath();
      ctx.arc(200, 200, 100, 0, Math.PI * 2);
      ctx.fill();

      const blob = await new Promise(resolve =>
        canvas.toBlob(resolve, 'image/png')
      );

      // Create a File from the blob
      const file = new File([blob], 'test-avatar.png', { type: 'image/png' });

      // Set it on the file input using DataTransfer
      const dataTransfer = new DataTransfer();
      dataTransfer.items.add(file);

      const avatarInput = document.querySelector('#avatar-input');
      avatarInput.files = dataTransfer.files;

      // Dispatch change event
      avatarInput.dispatchEvent(new Event('change', { bubbles: true }));

      // Wait for compressImage + FileReader to complete
      await new Promise(resolve => setTimeout(resolve, 2000));

      // Check if the preview was updated
      const container = document.getElementById('app');
      const imgPreview = container.querySelector('.avatar-preview');
      const placeholder = container.querySelector('.avatar-placeholder');

      return {
        previewExists: !!imgPreview,
        placeholderGone: !placeholder,
        previewSrc: imgPreview?.src?.slice(0, 30) || null,
        previewHasDataUrl: imgPreview?.src?.startsWith('data:image/') || false,
        previewSrcLength: imgPreview?.src?.length || 0,
      };
    });

    console.log('Upload result:', JSON.stringify(uploadResult, null, 2));
    expect(uploadResult.previewExists).toBe(true);
    expect(uploadResult.placeholderGone).toBe(true);
    expect(uploadResult.previewHasDataUrl).toBe(true);
    expect(uploadResult.previewSrcLength).toBeGreaterThan(100);

    console.log('PASS: File upload triggers compressImage, updates preview with data URL');

    // Now submit the form and verify avatarUrl is passed to the ORM
    const saveResult = await page.evaluate(async () => {
      // Fill in display name (required)
      const nameInput = document.querySelector('#display-name');
      nameInput.value = 'Test User';

      // Submit the form
      const form = document.querySelector('#profile-form');
      form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));

      // Wait for the async save
      await new Promise(resolve => setTimeout(resolve, 500));

      return {
        savedData: window.__savedProfileData || null,
      };
    });

    console.log('Save result:', JSON.stringify({
      ...saveResult,
      savedData: saveResult.savedData ? {
        ...saveResult.savedData,
        avatarUrl: saveResult.savedData.avatarUrl
          ? `${saveResult.savedData.avatarUrl.slice(0, 40)}... (${saveResult.savedData.avatarUrl.length} chars)`
          : null
      } : null
    }, null, 2));

    expect(saveResult.savedData).not.toBeNull();
    expect(saveResult.savedData.displayName).toBe('Test User');
    expect(saveResult.savedData.avatarUrl).toBeDefined();
    expect(saveResult.savedData.avatarUrl.startsWith('data:image/')).toBe(true);

    console.log('PASS: Form submit saves avatarUrl as data URL to Profile ORM');
  });
});
