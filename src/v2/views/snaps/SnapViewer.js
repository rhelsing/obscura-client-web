/**
 * SnapViewer View
 * Full-screen viewer for received snaps with auto-countdown timer
 */
import { navigate } from '../index.js';

let cleanup = null;

export function render({ snap, imageUrl, progress, displayName } = {}) {
  if (!snap) {
    return `
      <div class="view snap-viewer snap-viewer--loading">
        <div class="snap-viewer__loading">
          <p>Loading snap...</p>
        </div>
      </div>
    `;
  }

  return `
    <div class="view snap-viewer">
      <header class="snap-viewer__header">
        <button class="snap-viewer__close" id="close-btn">
          <ry-icon name="x"></ry-icon>
        </button>
        <span class="snap-viewer__sender">${displayName || snap.data?.senderUsername || 'Unknown'}</span>
        <div class="snap-viewer__timer">
          <div class="snap-viewer__timer-bar" style="width: ${progress}%"></div>
        </div>
      </header>

      <div class="snap-viewer__content">
        ${imageUrl ? `
          <img src="${imageUrl}" alt="Snap" class="snap-viewer__image" />
        ` : `
          <div class="snap-viewer__placeholder">
            <ry-icon name="image"></ry-icon>
          </div>
        `}

        ${snap.data?.caption ? `
          <div class="snap-viewer__caption">
            <p>${snap.data.caption}</p>
          </div>
        ` : ''}
      </div>
    </div>
  `;
}

export async function mount(container, client, router, params = {}) {
  const { username } = params;

  if (!username) {
    navigate('/chats');
    return;
  }

  // Show loading state
  container.innerHTML = render({});

  // Load unviewed snaps from this friend
  let snaps = [];
  try {
    snaps = await client.snap
      .where({
        'data.recipientUsername': client.username,
        'data.senderUsername': username,
        'data.viewedAt': null,
        'data._deleted': { ne: true }
      })
      .orderBy('timestamp', 'asc')
      .exec();
  } catch (err) {
    console.error('Failed to load snaps:', err);
    navigate(`/messages/${username}`);
    return;
  }

  if (snaps.length === 0) {
    // No snaps, go to chat
    navigate(`/messages/${username}`);
    return;
  }

  // Get display name for sender
  let displayName = username;
  try {
    const profiles = await client.profile.where({}).exec();
    const friend = client.friends.friends.get(username);
    if (friend?.devices) {
      for (const device of friend.devices) {
        const profile = profiles.find(p => p.authorDeviceId === device.deviceUUID);
        if (profile?.data?.displayName) {
          displayName = profile.data.displayName;
          break;
        }
      }
    }
  } catch (err) {
    console.warn('Failed to load profile:', err);
  }

  let currentIndex = 0;
  let timer = null;
  let startTime = null;
  let animationFrame = null;
  let currentImageUrl = null;
  let isCleanedUp = false;

  // Parse mediaRef and download image
  async function loadSnapImage(snap) {
    const mediaRef = snap.data?.mediaRef;
    if (!mediaRef) return null;

    try {
      const ref = JSON.parse(mediaRef);
      if (ref.attachmentId && ref.contentKey) {
        const contentRef = {
          attachmentId: ref.attachmentId,
          contentKey: new Uint8Array(ref.contentKey),
          nonce: new Uint8Array(ref.nonce),
          contentType: ref.contentType || 'image/jpeg'
        };
        const bytes = await client.attachments.download(contentRef);
        const blob = new Blob([bytes], { type: contentRef.contentType });
        return URL.createObjectURL(blob);
      }
    } catch (err) {
      console.error('Failed to load snap image:', err);
    }
    return null;
  }

  // Mark snap as viewed
  async function markViewed(snap) {
    try {
      await client.snap.upsert(snap.id, {
        ...snap.data,
        viewedAt: Date.now()
      });
    } catch (err) {
      console.error('Failed to mark snap as viewed:', err);
    }
  }

  // Display current snap
  async function showSnap(index) {
    if (isCleanedUp || index >= snaps.length) {
      // All snaps viewed, go to chat
      navigate(`/messages/${username}`);
      return;
    }

    const snap = snaps[index];
    const duration = (snap.data?.displayDuration || 5) * 1000;

    // Clean up previous image URL
    if (currentImageUrl) {
      URL.revokeObjectURL(currentImageUrl);
      currentImageUrl = null;
    }

    // Show loading while image loads
    container.innerHTML = render({ snap, imageUrl: null, progress: 100, displayName });

    // Load image
    currentImageUrl = await loadSnapImage(snap);

    if (isCleanedUp) return;

    // Mark as viewed
    await markViewed(snap);

    if (isCleanedUp) return;

    // Start timer animation
    startTime = Date.now();

    function updateProgress() {
      if (isCleanedUp) return;

      const elapsed = Date.now() - startTime;
      const progress = Math.max(0, 100 - (elapsed / duration) * 100);

      container.innerHTML = render({ snap, imageUrl: currentImageUrl, progress, displayName });

      // Re-attach close button handler
      const closeBtn = container.querySelector('#close-btn');
      if (closeBtn) {
        closeBtn.addEventListener('click', () => {
          cleanupAndNavigate(`/messages/${username}`);
        });
      }

      // Tap anywhere to skip to next
      const viewer = container.querySelector('.snap-viewer');
      if (viewer) {
        viewer.addEventListener('click', (e) => {
          if (e.target.id !== 'close-btn' && !e.target.closest('#close-btn')) {
            showNextSnap();
          }
        });
      }

      if (elapsed >= duration) {
        showNextSnap();
      } else {
        animationFrame = requestAnimationFrame(updateProgress);
      }
    }

    updateProgress();
  }

  function showNextSnap() {
    if (animationFrame) {
      cancelAnimationFrame(animationFrame);
      animationFrame = null;
    }
    currentIndex++;
    showSnap(currentIndex);
  }

  function cleanupAndNavigate(path) {
    isCleanedUp = true;
    if (animationFrame) {
      cancelAnimationFrame(animationFrame);
      animationFrame = null;
    }
    if (currentImageUrl) {
      URL.revokeObjectURL(currentImageUrl);
      currentImageUrl = null;
    }
    navigate(path);
  }

  // Start viewing
  showSnap(0);

  // Cleanup function
  cleanup = () => {
    isCleanedUp = true;
    if (animationFrame) {
      cancelAnimationFrame(animationFrame);
    }
    if (currentImageUrl) {
      URL.revokeObjectURL(currentImageUrl);
    }
  };
}

export function unmount() {
  if (cleanup) {
    cleanup();
    cleanup = null;
  }
}
