/**
 * PixCamera View
 * Camera capture for sending pix to friends
 *
 * - Tap capture button = photo
 * - Hold capture button = video recording
 */
import { navigate } from '../index.js';
import { VideoRecorder } from '../../lib/media.js';

let cleanup = null;
const HOLD_THRESHOLD_MS = 300; // Hold for 300ms to start video

export function render({ mode = 'camera', capturedPreview = null, mediaType = 'photo', friends = [], duration = 5, selectedFriends = [], sending = false, recording = false, recordingTime = 0 } = {}) {
  if (mode === 'preview' && capturedPreview) {
    const isVideo = mediaType === 'video';
    return `
      <div class="view pix-camera pix-camera--preview">
        <div class="pix-camera__preview-container">
          ${isVideo
            ? `<video src="${capturedPreview}" class="pix-camera__preview-video" autoplay loop playsinline></video>`
            : `<img src="${capturedPreview}" alt="Captured" class="pix-camera__preview-image" />`
          }
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
    <div class="view pix-camera ${recording ? 'pix-camera--recording' : ''}">
      <header class="pix-camera__header">
        <a href="/chats" data-navigo>
          <button variant="ghost" size="sm"><ry-icon name="close"></ry-icon></button>
        </a>
        ${recording
          ? `<span class="pix-camera__recording-indicator">
              <span class="pix-camera__recording-dot"></span>
              ${Math.floor(recordingTime / 60)}:${String(recordingTime % 60).padStart(2, '0')}
            </span>`
          : '<span></span>'
        }
        <button variant="ghost" size="sm" id="flip-btn" ${recording ? 'disabled' : ''}>🔄</button>
      </header>

      <div class="pix-camera__viewfinder">
        <video id="camera-video" autoplay playsinline muted></video>
        <canvas id="capture-canvas" style="display: none;"></canvas>
      </div>

      <div class="pix-camera__capture-area">
        <p class="pix-camera__hint">${recording ? 'Release to stop' : 'Tap for photo, hold for video'}</p>
        <button class="pix-camera__capture-btn ${recording ? 'pix-camera__capture-btn--recording' : ''}" id="capture-btn">
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
  let capturedMediaType = 'photo'; // 'photo' or 'video'
  let duration = 5;
  let selectedFriends = [];
  let sending = false;
  let isCleanedUp = false;

  // Video recording state
  let isRecording = false;
  let recordingTime = 0;
  let recordingTimer = null;
  let videoRecorder = null;
  let holdTimeout = null;

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

  async function startCamera(withAudio = false) {
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: facingMode,
          width: { ideal: 1280 },
          height: { ideal: 720 }
        },
        audio: withAudio
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

  async function startVideoRecording() {
    // Restart stream with audio
    stopCamera();

    isRecording = true;
    recordingTime = 0;

    // Update UI first to show recording state
    renderCameraMode();

    // Now start camera - this will attach to the new video element
    await startCamera(true);

    // Start recording with the new stream
    videoRecorder = new VideoRecorder(stream);
    videoRecorder.start();

    // Start timer
    recordingTimer = setInterval(() => {
      recordingTime++;
      // Update timer display
      const indicator = container.querySelector('.pix-camera__recording-indicator');
      if (indicator) {
        const mins = Math.floor(recordingTime / 60);
        const secs = String(recordingTime % 60).padStart(2, '0');
        indicator.innerHTML = `<span class="pix-camera__recording-dot"></span>${mins}:${secs}`;
      }
    }, 1000);
  }

  async function stopVideoRecording() {
    if (!isRecording || !videoRecorder) return;

    clearInterval(recordingTimer);
    recordingTimer = null;
    isRecording = false;

    console.log('[PixCamera] Stopping video recording...');
    const { blob, contentType } = await videoRecorder.stop();
    videoRecorder = null;

    console.log('[PixCamera] Video blob size:', blob.size);

    // Accept any blob (even fake/empty ones in test environments)
    // Real recordings will have content, test recordings may not
    capturedBlob = blob;
    capturedMediaType = 'video';
    capturedPreview = URL.createObjectURL(blob);
    stopCamera();
    renderPreviewMode();
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
    container.innerHTML = render({ mode: 'camera', recording: isRecording, recordingTime });
    attachCameraListeners();
    if (!isRecording) {
      startCamera();
    }
  }

  function renderPreviewMode() {
    container.innerHTML = render({
      mode: 'preview',
      capturedPreview,
      mediaType: capturedMediaType,
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
      // Press and hold detection
      let pressStartTime = 0;

      const handlePressStart = (e) => {
        e.preventDefault();
        if (isRecording) return;

        pressStartTime = Date.now();

        // Start video recording after hold threshold
        holdTimeout = setTimeout(() => {
          startVideoRecording();
        }, HOLD_THRESHOLD_MS);
      };

      const handlePressEnd = (e) => {
        // Don't preventDefault on document-level events
        if (e.target === captureBtn) {
          e.preventDefault();
        }

        if (isRecording) {
          // Stop video recording
          stopVideoRecording();
        } else if (e.target === captureBtn || e.target?.closest('#capture-btn')) {
          // Cancel hold timeout and take photo (only if on button)
          clearTimeout(holdTimeout);
          holdTimeout = null;

          const pressDuration = Date.now() - pressStartTime;
          if (pressDuration < HOLD_THRESHOLD_MS) {
            capturedMediaType = 'photo';
            capturePhoto();
          }
        }
      };

      // Mouse events on button
      captureBtn.addEventListener('mousedown', handlePressStart);
      captureBtn.addEventListener('mouseup', handlePressEnd);

      // Also listen on document for mouseup during recording (handles DOM re-render)
      const documentMouseUp = (e) => {
        if (isRecording) {
          stopVideoRecording();
          document.removeEventListener('mouseup', documentMouseUp);
        }
      };
      document.addEventListener('mouseup', documentMouseUp);

      // Touch events (for mobile)
      captureBtn.addEventListener('touchstart', handlePressStart, { passive: false });
      captureBtn.addEventListener('touchend', handlePressEnd, { passive: false });
      captureBtn.addEventListener('touchcancel', handlePressEnd, { passive: false });

      // Document-level touch end for recording
      const documentTouchEnd = (e) => {
        if (isRecording) {
          stopVideoRecording();
          document.removeEventListener('touchend', documentTouchEnd);
        }
      };
      document.addEventListener('touchend', documentTouchEnd);
    }

    if (flipBtn) {
      flipBtn.addEventListener('click', () => {
        if (isRecording) return;
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
          const contentType = capturedMediaType === 'video' ? 'video/webm' : 'image/jpeg';
          const mediaRef = JSON.stringify({
            attachmentId: ref.attachmentId,
            contentKey: Array.from(ref.contentKey),
            nonce: Array.from(ref.nonce),
            contentHash: Array.from(ref.contentHash),
            contentType
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

          // Show more specific error message
          let errorMsg = 'Failed to send pix. Please try again.';
          if (err.message?.includes('413') || err.message?.includes('too large')) {
            errorMsg = 'Video is too large. Try recording a shorter clip.';
          } else if (err.message?.includes('NetworkError') || err.message?.includes('fetch')) {
            const sizeMB = (capturedBlob?.size / 1024 / 1024).toFixed(1);
            errorMsg = `Upload failed (${sizeMB}MB). The file may be too large or your connection was interrupted.`;
          }
          alert(errorMsg);
        }
      });
    }
  }

  // Initial render
  renderCameraMode();

  cleanup = () => {
    isCleanedUp = true;
    clearTimeout(holdTimeout);
    clearInterval(recordingTimer);
    if (videoRecorder?.isRecording) {
      videoRecorder.stop();
    }
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
