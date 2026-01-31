/**
 * PixCamera View
 * Camera capture for sending pix to friends
 */
import { navigate } from '../index.js';

let cleanup = null;

export function render({ mode = 'camera', capturedPreview = null, friends = [], duration = 5, selectedFriends = [], sending = false } = {}) {
  if (mode === 'preview' && capturedPreview) {
    return `
      <div class="view pix-camera pix-camera--preview">
        <div class="pix-camera__preview-container">
          <img src="${capturedPreview}" alt="Captured" class="pix-camera__preview-image" />
          <input
            type="text"
            class="pix-camera__caption"
            id="caption-input"
            placeholder="Add a caption..."
            maxlength="100"
          />
        </div>

        <div class="pix-camera__controls">
          <button class="pix-camera__btn" id="cancel-btn">
            <ry-icon name="close"></ry-icon>
          </button>

          <div class="pix-camera__duration">
            <input type="range" id="duration-slider" min="1" max="10" value="${duration}" />
            <span id="duration-value">${duration}s</span>
          </div>

          <button class="pix-camera__btn pix-camera__btn--send ${sending ? 'pix-camera__btn--loading' : ''}" id="send-btn" ${sending ? 'disabled' : ''}>
            ${sending ? '<span class="pix-camera__spinner"></span>' : '<ry-icon name="chevron-right"></ry-icon>'}
          </button>
        </div>

        <div class="pix-camera__friend-picker" id="friend-picker">
          <h3>Send to${selectedFriends.length > 0 ? ` (${selectedFriends.length})` : ''}</h3>
          <ry-stack gap="sm">
            ${friends.length === 0 ? `
              <p style="color: var(--ry-color-text-muted)">No friends yet</p>
            ` : friends.map(f => `
              <ry-card class="pix-camera__friend-item ${selectedFriends.includes(f.username) ? 'selected' : ''}" data-username="${f.username}">
                <ry-cluster>
                  <ry-icon name="user"></ry-icon>
                  <span>${f.displayName || f.username}</span>
                  ${selectedFriends.includes(f.username) ? '<ry-icon name="check"></ry-icon>' : ''}
                </ry-cluster>
              </ry-card>
            `).join('')}
          </ry-stack>
        </div>
      </div>
    `;
  }

  return `
    <div class="view pix-camera">
      <header class="pix-camera__header">
        <a href="/chats" data-navigo>
          <button variant="ghost" size="sm"><ry-icon name="close"></ry-icon></button>
        </a>
        <span></span>
        <button variant="ghost" size="sm" id="flip-btn">🔄</button>
      </header>

      <div class="pix-camera__viewfinder">
        <video id="camera-video" autoplay playsinline muted></video>
        <canvas id="capture-canvas" style="display: none;"></canvas>
      </div>

      <div class="pix-camera__capture-area">
        <button class="pix-camera__capture-btn" id="capture-btn">
          <span class="pix-camera__capture-btn-inner"></span>
        </button>
      </div>
    </div>
  `;
}

export async function mount(container, client, router) {
  let stream = null;
  let facingMode = 'user';
  let capturedPreview = null;
  let capturedBlob = null;
  let duration = 5;
  let selectedFriends = [];
  let sending = false;
  let isCleanedUp = false;

  // Get accepted friends
  const friends = [];
  if (client.friends?.friends) {
    for (const [username, data] of client.friends.friends) {
      if (data.status === 'accepted') {
        friends.push({ username, displayName: null });
      }
    }
  }

  // Load display names from profiles
  try {
    const profiles = await client.profile.where({}).exec();
    for (const friend of friends) {
      const friendData = client.friends.friends.get(friend.username);
      if (friendData?.devices) {
        for (const device of friendData.devices) {
          const profile = profiles.find(p => p.authorDeviceId === device.deviceUUID);
          if (profile?.data?.displayName) {
            friend.displayName = profile.data.displayName;
            break;
          }
        }
      }
    }
  } catch (err) {
    console.warn('Failed to load profiles:', err);
  }

  async function startCamera() {
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: facingMode,
          width: { ideal: 1280 },
          height: { ideal: 720 }
        },
        audio: false
      });

      const video = container.querySelector('#camera-video');
      if (video && !isCleanedUp) {
        video.srcObject = stream;
        // Mirror front camera
        video.style.transform = facingMode === 'user' ? 'scaleX(-1)' : 'none';
      }
    } catch (err) {
      console.error('Failed to start camera:', err);
    }
  }

  function stopCamera() {
    if (stream) {
      stream.getTracks().forEach(track => track.stop());
      stream = null;
    }
  }

  function capturePhoto() {
    const video = container.querySelector('#camera-video');
    const canvas = container.querySelector('#capture-canvas');
    if (!video || !canvas) return;

    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;

    const ctx = canvas.getContext('2d');

    // Mirror if front camera
    if (facingMode === 'user') {
      ctx.translate(canvas.width, 0);
      ctx.scale(-1, 1);
    }

    ctx.drawImage(video, 0, 0);

    canvas.toBlob(blob => {
      capturedBlob = blob;
      capturedPreview = URL.createObjectURL(blob);
      stopCamera();
      renderPreviewMode();
    }, 'image/jpeg', 0.9);
  }

  function renderCameraMode() {
    container.innerHTML = render({ mode: 'camera' });
    attachCameraListeners();
    startCamera();
  }

  function renderPreviewMode() {
    container.innerHTML = render({
      mode: 'preview',
      capturedPreview,
      friends,
      duration,
      selectedFriends,
      sending
    });
    attachPreviewListeners();
  }

  function attachCameraListeners() {
    const captureBtn = container.querySelector('#capture-btn');
    const flipBtn = container.querySelector('#flip-btn');

    if (captureBtn) {
      captureBtn.addEventListener('click', capturePhoto);
    }

    if (flipBtn) {
      flipBtn.addEventListener('click', () => {
        facingMode = facingMode === 'user' ? 'environment' : 'user';
        stopCamera();
        startCamera();
      });
    }

    router.updatePageLinks();
  }

  function attachPreviewListeners() {
    const cancelBtn = container.querySelector('#cancel-btn');
    const sendBtn = container.querySelector('#send-btn');
    const durationSlider = container.querySelector('#duration-slider');
    const durationValue = container.querySelector('#duration-value');
    const friendItems = container.querySelectorAll('.pix-camera__friend-item');

    if (cancelBtn) {
      cancelBtn.addEventListener('click', () => {
        if (capturedPreview) {
          URL.revokeObjectURL(capturedPreview);
          capturedPreview = null;
          capturedBlob = null;
        }
        selectedFriends = [];
        renderCameraMode();
      });
    }

    if (durationSlider && durationValue) {
      durationSlider.addEventListener('input', () => {
        duration = parseInt(durationSlider.value, 10);
        durationValue.textContent = `${duration}s`;
      });
    }

    friendItems.forEach(item => {
      item.addEventListener('click', () => {
        const username = item.dataset.username;
        // Toggle selection
        const idx = selectedFriends.indexOf(username);
        if (idx === -1) {
          selectedFriends.push(username);
        } else {
          selectedFriends.splice(idx, 1);
        }
        renderPreviewMode();
      });
    });

    if (sendBtn) {
      sendBtn.addEventListener('click', async () => {
        if (selectedFriends.length === 0 || !capturedBlob || sending) return;

        sending = true;
        renderPreviewMode();

        try {
          // Upload attachment ONCE (shared across all recipients)
          const bytes = new Uint8Array(await capturedBlob.arrayBuffer());
          const ref = await client.attachments.upload(bytes);

          // Get caption
          const captionInput = container.querySelector('#caption-input');
          const caption = captionInput?.value || '';

          // Create pix for EACH selected recipient
          const mediaRef = JSON.stringify({
            attachmentId: ref.attachmentId,
            contentKey: Array.from(ref.contentKey),
            nonce: Array.from(ref.nonce),
            contentHash: Array.from(ref.contentHash),
            contentType: 'image/jpeg'
          });

          for (const recipientUsername of selectedFriends) {
            await client.pix.create({
              recipientUsername,
              senderUsername: client.username,
              mediaRef,
              caption: caption || null,
              displayDuration: duration
            });
          }

          // Success - go back to pix list
          navigate('/pix');
        } catch (err) {
          console.error('Failed to send pix:', err);
          sending = false;
          renderPreviewMode();
          alert('Failed to send pix. Please try again.');
        }
      });
    }
  }

  // Initial render
  renderCameraMode();

  cleanup = () => {
    isCleanedUp = true;
    stopCamera();
    if (capturedPreview) {
      URL.revokeObjectURL(capturedPreview);
    }
  };
}

export function unmount() {
  if (cleanup) {
    cleanup();
    cleanup = null;
  }
}
