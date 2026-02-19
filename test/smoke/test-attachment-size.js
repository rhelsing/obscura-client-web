/**
 * Test attachment size limits
 *
 * Run: source .env && node test/smoke/test-attachment-size.js
 *
 * Tests progressively larger uploads to find the server limit.
 */

const API_URL = process.env.VITE_API_URL || 'http://localhost:3000';

async function register() {
  const username = `sizetest_${Date.now()}`;
  const password = 'testpass12345';

  const res = await fetch(`${API_URL}/v1/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      username,
      password,
      identity_key: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
      signed_pre_key: {
        key_id: 1,
        public_key: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
        signature: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA==',
      },
      pre_keys: [{
        key_id: 1,
        public_key: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
      }],
    }),
  });

  if (!res.ok) {
    throw new Error(`Registration failed: ${res.status} ${await res.text()}`);
  }

  const data = await res.json();
  return { username, token: data.token };
}

async function testUploadSize(token, sizeBytes) {
  // Create a blob of random data
  const data = new Uint8Array(sizeBytes);
  for (let i = 0; i < sizeBytes; i++) {
    data[i] = Math.floor(Math.random() * 256);
  }

  const sizeMB = (sizeBytes / (1024 * 1024)).toFixed(2);
  console.log(`Testing ${sizeMB} MB (${sizeBytes} bytes)...`);

  try {
    const res = await fetch(`${API_URL}/v1/attachments`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/octet-stream',
        'Content-Length': sizeBytes.toString(),
      },
      body: data,
    });

    if (res.ok) {
      const result = await res.json();
      console.log(`  ✓ SUCCESS - ID: ${result.id?.slice(0, 8)}...`);
      return { success: true, size: sizeBytes };
    } else {
      const text = await res.text();
      console.log(`  ✗ FAILED - ${res.status}: ${text.slice(0, 100)}`);
      return { success: false, size: sizeBytes, status: res.status, error: text };
    }
  } catch (err) {
    console.log(`  ✗ ERROR - ${err.message}`);
    return { success: false, size: sizeBytes, error: err.message };
  }
}

async function main() {
  console.log(`\n=== Attachment Size Limit Test ===`);
  console.log(`API: ${API_URL}\n`);

  // Register a test user
  console.log('Registering test user...');
  const { username, token } = await register();
  console.log(`Registered: ${username}\n`);

  // Test sizes: 100KB, 500KB, 1MB, 2MB, 5MB, 10MB, 20MB, 50MB, 100MB
  const testSizes = [
    100 * 1024,        // 100 KB
    500 * 1024,        // 500 KB
    1 * 1024 * 1024,   // 1 MB
    2 * 1024 * 1024,   // 2 MB
    5 * 1024 * 1024,   // 5 MB
    10 * 1024 * 1024,  // 10 MB
    20 * 1024 * 1024,  // 20 MB
    50 * 1024 * 1024,  // 50 MB
  ];

  let lastSuccess = 0;
  let firstFailure = null;

  for (const size of testSizes) {
    const result = await testUploadSize(token, size);

    if (result.success) {
      lastSuccess = size;
    } else {
      firstFailure = result;
      break;
    }

    // Small delay between tests
    await new Promise(r => setTimeout(r, 500));
  }

  console.log(`\n=== Results ===`);
  console.log(`Last successful size: ${(lastSuccess / (1024 * 1024)).toFixed(2)} MB`);
  if (firstFailure) {
    console.log(`First failure at: ${(firstFailure.size / (1024 * 1024)).toFixed(2)} MB`);
    console.log(`Failure reason: ${firstFailure.status || 'Network error'} - ${firstFailure.error?.slice(0, 200)}`);
  } else {
    console.log(`All tests passed up to ${(lastSuccess / (1024 * 1024)).toFixed(2)} MB`);
  }

  // If we found a boundary, do binary search to find exact limit
  if (firstFailure && lastSuccess > 0) {
    console.log(`\n=== Binary Search for Exact Limit ===`);
    let low = lastSuccess;
    let high = firstFailure.size;

    while (high - low > 100 * 1024) { // Within 100KB precision
      const mid = Math.floor((low + high) / 2);
      const result = await testUploadSize(token, mid);

      if (result.success) {
        low = mid;
      } else {
        high = mid;
      }

      await new Promise(r => setTimeout(r, 300));
    }

    console.log(`\n=== Final Result ===`);
    console.log(`Server limit is approximately: ${(low / (1024 * 1024)).toFixed(2)} MB`);
  }
}

main().catch(console.error);
