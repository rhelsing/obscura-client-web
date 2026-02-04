/**
 * PixViewer View
 * Full-screen viewer for received pix with auto-countdown timer
 */
import { navigate, refreshPixBadge } from '../index.js';
import { getMediaCategory } from '../../lib/media.js';

let cleanup = null;

export function render({ pix, mediaUrl, mediaType, progress, displayName } = {}) {
  if (!pix) {
    return `
      <div class="view pix-viewer pix-viewer--loading">
        <div class="pix-viewer__loading">
          <p>Loading pix...</p>
        </div>
      </div>
    `;
  }

  // Render media based on type
  console.log('[PixViewer] render() called with mediaType:', mediaType, 'mediaUrl:', mediaUrl ? 'present' : 'null');
  let mediaHtml = '';
  if (mediaUrl) {
    if (mediaType === 'video') {
      // Video: autoplay, loop, muted for auto-start, with controls as fallback
      console.log('[PixViewer] Rendering VIDEO element');
      mediaHtml = `<video src="${mediaUrl}" class="pix-viewer__video" autoplay loop playsinline preload="auto"></video>`;
    } else if (mediaType === 'audio') {
      mediaHtml = `<audio src="${mediaUrl}" class="pix-viewer__audio" controls autoplay></audio>`;
    } else {
      console.log('[PixViewer] Rendering IMG element (mediaType:', mediaType, ')');
      mediaHtml = `<img src="${mediaUrl}" alt="Pix" class="pix-viewer__image" />`;
    }
  } else {
    mediaHtml = `
      <div class="pix-viewer__placeholder">
        <ry-icon name="image"></ry-icon>
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
        ${mediaHtml}

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
  let currentMediaUrl = null;
  let currentMediaType = 'image';
  let isCleanedUp = false;

  // Parse mediaRef and download media (image, video, or audio)
  async function loadPixMedia(pix) {
    const mediaRef = pix.data?.mediaRef;
    if (!mediaRef) return { url: null, mediaType: 'image' };

    try {
      const ref = JSON.parse(mediaRef);
      console.log('[PixViewer] Parsed mediaRef:', { attachmentId: ref.attachmentId, contentType: ref.contentType });
      if (ref.attachmentId && ref.contentKey) {
        const contentType = ref.contentType || 'image/jpeg';
        const contentRef = {
          attachmentId: ref.attachmentId,
          contentKey: new Uint8Array(ref.contentKey),
          nonce: new Uint8Array(ref.nonce),
          contentHash: ref.contentHash ? new Uint8Array(ref.contentHash) : undefined,
          contentType
        };
        console.log('[PixViewer] Downloading attachment...');
        const bytes = await client.attachments.download(contentRef);
        console.log('[PixViewer] Downloaded bytes:', bytes.length);
        const blob = new Blob([bytes], { type: contentType });
        console.log('[PixViewer] Created blob:', blob.size, 'bytes, type:', blob.type);
        const url = URL.createObjectURL(blob);
        console.log('[PixViewer] Created blob URL:', url);
        const mediaType = getMediaCategory(contentType);
        console.log('[PixViewer] Media category:', mediaType);
        return { url, mediaType };
      }
    } catch (err) {
      console.error('[PixViewer] Failed to load pix media:', err);
    }
    return { url: null, mediaType: 'image' };
  }

  // Mark pix as viewed
  async function markViewed(pix) {
    try {
      await client.pix.upsert(pix.id, {
        ...pix.data,
        viewedAt: Date.now()
      });
      refreshPixBadge();
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

    // Clean up previous media URL
    if (currentMediaUrl) {
      URL.revokeObjectURL(currentMediaUrl);
      currentMediaUrl = null;
    }

    // Show loading while media loads
    container.innerHTML = render({ pix, mediaUrl: null, mediaType: 'image', progress: 100, displayName });

    // Load media
    const { url, mediaType } = await loadPixMedia(pix);
    currentMediaUrl = url;
    currentMediaType = mediaType;

    if (isCleanedUp) return;

    // Mark as viewed
    await markViewed(pix);

    if (isCleanedUp) return;

    // Start timer animation
    startTime = Date.now();

    // Render once at the start
    container.innerHTML = render({ pix, mediaUrl: currentMediaUrl, mediaType: currentMediaType, progress: 100, displayName });

    // Attach event handlers once
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

    // Start video playback
    const video = container.querySelector('.pix-viewer__video');
    if (video) {
      console.log('[PixViewer] Video element found, src:', video.src);
      video.onloadeddata = () => console.log('[PixViewer] Video loadeddata event');
      video.oncanplay = () => console.log('[PixViewer] Video canplay event');
      video.onplay = () => console.log('[PixViewer] Video play event');
      video.onerror = () => console.error('[PixViewer] Video error:', video.error?.message, video.error?.code);

      video.play().then(() => {
        console.log('[PixViewer] Video play() succeeded');
      }).catch((err) => {
        console.warn('[PixViewer] Video play() failed:', err.message);
        video.muted = true;
        video.play().catch((err2) => {
          console.error('[PixViewer] Video play() failed even muted:', err2.message);
        });
      });
    }

    // Only update the progress bar, not the whole container
    function updateProgress() {
      if (isCleanedUp) return;

      const elapsed = Date.now() - startTime;
      const progress = Math.max(0, 100 - (elapsed / duration) * 100);

      // Update only the progress bar width
      const progressBar = container.querySelector('.pix-viewer__timer-bar');
      if (progressBar) {
        progressBar.style.width = `${progress}%`;
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
    if (currentMediaUrl) {
      URL.revokeObjectURL(currentMediaUrl);
      currentMediaUrl = null;
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
    if (currentMediaUrl) {
      URL.revokeObjectURL(currentMediaUrl);
    }
  };
}

export function unmount() {
  if (cleanup) {
    cleanup();
    cleanup = null;
  }
}
