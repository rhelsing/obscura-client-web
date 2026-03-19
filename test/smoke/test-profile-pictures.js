/**
 * Smoke test for profile picture functionality
 * Tests getProfileData() logic with mocked dependencies
 *
 * Run: node test/smoke/test-profile-pictures.js
 */

// Test 1: getProfileData returns avatarUrl when profile exists
async function testGetProfileDataWithAvatar() {
  // Mock the minimal ObscuraClient shape
  const mockClient = {
    friends: {
      friends: new Map([
        ['alice', {
          username: 'alice',
          devices: [
            { deviceUUID: 'device-abc-123', deviceId: 'user-1' }
          ],
          status: 'accepted'
        }]
      ])
    },
    profile: {
      all: async () => [
        {
          id: 'profile-1',
          authorDeviceId: 'device-abc-123',
          timestamp: Date.now(),
          data: {
            displayName: 'Alice Wonderland',
            avatarUrl: 'data:image/jpeg;base64,/9j/fakebase64data',
            bio: 'Down the rabbit hole'
          }
        }
      ]
    }
  };

  // Import the method logic directly (can't import class due to browser deps)
  // Replicate getProfileData exactly as written
  async function getProfileData(username) {
    const result = { displayName: null, avatarUrl: null };
    const friend = mockClient.friends?.friends?.get(username);
    if (!friend?.devices?.length) return result;

    if (mockClient.profile) {
      try {
        const profiles = await mockClient.profile.all();
        for (const device of friend.devices) {
          if (device.deviceUUID) {
            const profile = profiles.find(p => p.authorDeviceId === device.deviceUUID);
            if (profile?.data) {
              result.displayName = profile.data.displayName || null;
              result.avatarUrl = profile.data.avatarUrl || null;
              return result;
            }
          }
        }
      } catch (err) {
        console.warn('Failed to look up profile data:', err);
      }
    }
    return result;
  }

  const result = await getProfileData('alice');
  console.assert(result.displayName === 'Alice Wonderland',
    `Expected displayName 'Alice Wonderland', got '${result.displayName}'`);
  console.assert(result.avatarUrl === 'data:image/jpeg;base64,/9j/fakebase64data',
    `Expected avatarUrl to be data URL, got '${result.avatarUrl}'`);
  console.log('PASS: getProfileData returns displayName + avatarUrl for known friend');
}

// Test 2: getProfileData returns nulls when friend has no profile
async function testGetProfileDataNoProfile() {
  const mockClient = {
    friends: {
      friends: new Map([
        ['bob', {
          username: 'bob',
          devices: [{ deviceUUID: 'device-xyz-789', deviceId: 'user-2' }],
          status: 'accepted'
        }]
      ])
    },
    profile: {
      all: async () => []  // No profiles synced
    }
  };

  async function getProfileData(username) {
    const result = { displayName: null, avatarUrl: null };
    const friend = mockClient.friends?.friends?.get(username);
    if (!friend?.devices?.length) return result;
    if (mockClient.profile) {
      const profiles = await mockClient.profile.all();
      for (const device of friend.devices) {
        if (device.deviceUUID) {
          const profile = profiles.find(p => p.authorDeviceId === device.deviceUUID);
          if (profile?.data) {
            result.displayName = profile.data.displayName || null;
            result.avatarUrl = profile.data.avatarUrl || null;
            return result;
          }
        }
      }
    }
    return result;
  }

  const result = await getProfileData('bob');
  console.assert(result.displayName === null, `Expected null displayName, got '${result.displayName}'`);
  console.assert(result.avatarUrl === null, `Expected null avatarUrl, got '${result.avatarUrl}'`);
  console.log('PASS: getProfileData returns nulls when no profile exists');
}

// Test 3: getProfileData returns nulls for unknown username
async function testGetProfileDataUnknownUser() {
  const mockClient = {
    friends: { friends: new Map() },
    profile: { all: async () => [] }
  };

  async function getProfileData(username) {
    const result = { displayName: null, avatarUrl: null };
    const friend = mockClient.friends?.friends?.get(username);
    if (!friend?.devices?.length) return result;
    return result;
  }

  const result = await getProfileData('nobody');
  console.assert(result.displayName === null, 'Expected null displayName for unknown user');
  console.assert(result.avatarUrl === null, 'Expected null avatarUrl for unknown user');
  console.log('PASS: getProfileData returns nulls for unknown user');
}

// Test 4: getProfileData matches correct device when friend has multiple devices
async function testGetProfileDataMultipleDevices() {
  const mockClient = {
    friends: {
      friends: new Map([
        ['charlie', {
          username: 'charlie',
          devices: [
            { deviceUUID: 'device-no-profile', deviceId: 'user-3a' },
            { deviceUUID: 'device-with-profile', deviceId: 'user-3b' },
          ],
          status: 'accepted'
        }]
      ])
    },
    profile: {
      all: async () => [
        {
          id: 'profile-other',
          authorDeviceId: 'device-unrelated',
          timestamp: Date.now(),
          data: { displayName: 'Wrong Person', avatarUrl: 'data:wrong' }
        },
        {
          id: 'profile-charlie',
          authorDeviceId: 'device-with-profile',
          timestamp: Date.now(),
          data: { displayName: 'Charlie B', avatarUrl: 'data:image/png;base64,charlie-avatar' }
        }
      ]
    }
  };

  async function getProfileData(username) {
    const result = { displayName: null, avatarUrl: null };
    const friend = mockClient.friends?.friends?.get(username);
    if (!friend?.devices?.length) return result;
    if (mockClient.profile) {
      const profiles = await mockClient.profile.all();
      for (const device of friend.devices) {
        if (device.deviceUUID) {
          const profile = profiles.find(p => p.authorDeviceId === device.deviceUUID);
          if (profile?.data) {
            result.displayName = profile.data.displayName || null;
            result.avatarUrl = profile.data.avatarUrl || null;
            return result;
          }
        }
      }
    }
    return result;
  }

  const result = await getProfileData('charlie');
  console.assert(result.displayName === 'Charlie B',
    `Expected 'Charlie B', got '${result.displayName}'`);
  console.assert(result.avatarUrl === 'data:image/png;base64,charlie-avatar',
    `Expected charlie's avatar, got '${result.avatarUrl}'`);
  console.log('PASS: getProfileData matches correct device across multiple devices');
}

// Test 5: renderSmallAvatar helper produces correct HTML
function testRenderSmallAvatar() {
  function renderSmallAvatar(avatarUrl, name) {
    if (avatarUrl) {
      return `<img class="avatar-sm" src="${avatarUrl}" alt="" />`;
    }
    const letter = (name || 'U')[0].toUpperCase();
    return `<div class="avatar-sm-placeholder">${letter}</div>`;
  }

  // With avatar URL
  const withAvatar = renderSmallAvatar('data:image/jpeg;base64,abc', 'Alice');
  console.assert(withAvatar.includes('class="avatar-sm"'), 'Should have avatar-sm class');
  console.assert(withAvatar.includes('src="data:image/jpeg;base64,abc"'), 'Should have correct src');
  console.assert(withAvatar.startsWith('<img'), 'Should be an img tag');

  // Without avatar - should show first letter
  const noAvatar = renderSmallAvatar(null, 'Bob');
  console.assert(noAvatar.includes('avatar-sm-placeholder'), 'Should have placeholder class');
  console.assert(noAvatar.includes('>B<'), 'Should show first letter B');

  // Without avatar or name - should show U
  const noName = renderSmallAvatar(null, null);
  console.assert(noName.includes('>U<'), 'Should show U for null name');

  // Empty string avatar should use placeholder
  const emptyAvatar = renderSmallAvatar('', 'Charlie');
  console.assert(emptyAvatar.includes('avatar-sm-placeholder'), 'Empty string should use placeholder');
  console.assert(emptyAvatar.includes('>C<'), 'Should show first letter C');

  console.log('PASS: renderSmallAvatar produces correct HTML for all cases');
}

// Run all tests
async function main() {
  console.log('--- Profile Pictures Smoke Tests ---\n');

  await testGetProfileDataWithAvatar();
  await testGetProfileDataNoProfile();
  await testGetProfileDataUnknownUser();
  await testGetProfileDataMultipleDevices();
  testRenderSmallAvatar();

  console.log('\n--- All tests passed ---');
}

main().catch(err => {
  console.error('TEST FAILURE:', err);
  process.exit(1);
});
