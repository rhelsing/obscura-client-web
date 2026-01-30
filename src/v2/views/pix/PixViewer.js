/**
 * PixViewer View
 * Full-screen viewer for received pix with auto-countdown timer
 */
import { navigate } from '../index.js';

let cleanup = null;

export function render({ pix, imageUrl, progress, displayName } = {}) {
  if (!pix) {
    return `
      <div class="view pix-viewer pix-viewer--loading">
        <div class="pix-viewer__loading">
          <p>Loading pix...</p>
        </div>
      </div>
    `;
  }

  return `
    <div class="view pix-viewer">
      <header class="pix-viewer__header">
        <button class="pix-viewer__close" id="close-btn">
          <ry-icon name="x"></ry-icon>
        </button>
        <span class="pix-viewer__sender">${displayName || pix.data?.senderUsername || 'Unknown'}</span>
        <div class="pix-viewer__timer">
          <div class="pix-viewer__timer-bar" style="width: ${progress}%"></div>
        </div>
      </header>

      <div class="pix-viewer__content">
        ${imageUrl ? `
          <img src="${imageUrl}" alt="Pix" class="pix-viewer__image" />
        ` : `
          <div class="pix-viewer__placeholder">
            <ry-icon name="image"></ry-icon>
          </div>
        `}

        ${pix.data?.caption ? `
          <div class="pix-viewer__caption">
            <p>${pix.data.caption}</p>
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

  // Load unviewed pix from this friend
  let pixList = [];
  try {
    const allPix = await client.pix.all();
    pixList = allPix
      .filter(p =>
        p.data?.recipientUsername === client.username &&
        p.data?.senderUsername === username &&
        !p.data?.viewedAt &&
        !p.data?._deleted
      )
      .sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));
  } catch (err) {
    console.error('Failed to load pix:', err);
    navigate('/pix');
    return;
  }

  if (pixList.length === 0) {
    // No pix, go back to pix list
    navigate('/pix');
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
  async function loadPixImage(pix) {
    const mediaRef = pix.data?.mediaRef;
    if (!mediaRef) return null;

    try {
      const ref = JSON.parse(mediaRef);
      if (ref.attachmentId && ref.contentKey) {
        const contentRef = {
          attachmentId: ref.attachmentId,
          contentKey: new Uint8Array(ref.contentKey),
          nonce: new Uint8Array(ref.nonce),
          contentHash: ref.contentHash ? new Uint8Array(ref.contentHash) : undefined,
          contentType: ref.contentType || 'image/jpeg'
        };
        const bytes = await client.attachments.download(contentRef);
        const blob = new Blob([bytes], { type: contentRef.contentType });
        return URL.createObjectURL(blob);
      }
    } catch (err) {
      console.error('Failed to load pix image:', err);
    }
    return null;
  }

  // Mark pix as viewed
  async function markViewed(pix) {
    try {
      await client.pix.upsert(pix.id, {
        ...pix.data,
        viewedAt: Date.now()
      });
    } catch (err) {
      console.error('Failed to mark pix as viewed:', err);
    }
  }

  // Display current pix
  async function showPix(index) {
    if (isCleanedUp || index >= pixList.length) {
      // All pix viewed, go back to pix list
      navigate('/pix');
      return;
    }

    const pix = pixList[index];
    const duration = (pix.data?.displayDuration || 5) * 1000;

    // Clean up previous image URL
    if (currentImageUrl) {
      URL.revokeObjectURL(currentImageUrl);
      currentImageUrl = null;
    }

    // Show loading while image loads
    container.innerHTML = render({ pix, imageUrl: null, progress: 100, displayName });

    // Load image
    currentImageUrl = await loadPixImage(pix);

    if (isCleanedUp) return;

    // Mark as viewed
    await markViewed(pix);

    if (isCleanedUp) return;

    // Start timer animation
    startTime = Date.now();

    function updateProgress() {
      if (isCleanedUp) return;

      const elapsed = Date.now() - startTime;
      const progress = Math.max(0, 100 - (elapsed / duration) * 100);

      container.innerHTML = render({ pix, imageUrl: currentImageUrl, progress, displayName });

      // Re-attach close button handler
      const closeBtn = container.querySelector('#close-btn');
      if (closeBtn) {
        closeBtn.addEventListener('click', () => {
          cleanupAndNavigate('/pix');
        });
      }

      // Tap anywhere to skip to next
      const viewer = container.querySelector('.pix-viewer');
      if (viewer) {
        viewer.addEventListener('click', (e) => {
          if (e.target.id !== 'close-btn' && !e.target.closest('#close-btn')) {
            showNextPix();
          }
        });
      }

      if (elapsed >= duration) {
        showNextPix();
      } else {
        animationFrame = requestAnimationFrame(updateProgress);
      }
    }

    updateProgress();
  }

  function showNextPix() {
    if (animationFrame) {
      cancelAnimationFrame(animationFrame);
      animationFrame = null;
    }
    currentIndex++;
    showPix(currentIndex);
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
  showPix(0);

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
