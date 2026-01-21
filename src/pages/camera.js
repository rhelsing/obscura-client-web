// Camera page - photo capture and QR scanning
import { Html5Qrcode } from 'html5-qrcode';
import client from '../api/client.js';
import gateway from '../api/gateway.js';
import { sessionManager } from '../lib/sessionManager.js';
import { friendStore, FriendStatus } from '../lib/friendStore.js';
import { FEATURES } from '../lib/config.js';

export function renderCamera(container, { onSwitchTab, friends, refreshFriends }) {
  let mode = 'photo'; // 'photo' or 'qr'
  let facingMode = 'user'; // 'user' (front) or 'environment' (back)
  let stream = null;
  let qrScanner = null;
  let capturedPhoto = null;
  let textOverlay = '';
  let timerValue = 8;
  let selectedFriend = null;
  let showFriendPicker = false;
  let isSending = false;

  async function render() {
    if (capturedPhoto) {
      renderPhotoPreview();
    } else if (mode === 'qr') {
      renderQRScanner();
    } else {
      renderCameraView();
    }
  }

  function renderCameraView() {
    container.innerHTML = `
      <div class="camera-view">
        <div class="camera-preview">
          <video id="camera-video" autoplay playsinline></video>
          <div class="camera-controls">
            <button class="camera-btn ${mode === 'qr' ? 'active' : ''}" id="qr-toggle" title="Scan QR">
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <rect x="3" y="3" width="7" height="7"/>
                <rect x="14" y="3" width="7" height="7"/>
                <rect x="3" y="14" width="7" height="7"/>
                <rect x="14" y="14" width="7" height="7"/>
              </svg>
            </button>
            <button class="camera-btn" id="flip-camera" title="Flip Camera">
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M16 3h5v5"/>
                <path d="M8 21H3v-5"/>
                <path d="M21 3l-7 7"/>
                <path d="M3 21l7-7"/>
              </svg>
            </button>
          </div>
          <div class="camera-capture">
            <button class="capture-btn" id="capture-btn">
              <div class="capture-btn-inner"></div>
            </button>
          </div>
        </div>
      </div>
    `;

    attachCameraListeners();
    startCamera();
  }

  function renderQRScanner() {
    container.innerHTML = `
      <div class="qr-scanner-view">
        <div class="qr-scanner-preview">
          <div id="qr-reader"></div>
          <div class="qr-scanner-overlay">
            <div class="qr-scanner-frame"></div>
          </div>
        </div>
        <div class="camera-controls" style="position: absolute; top: 1rem; left: 0; right: 0;">
          <button class="camera-btn active" id="qr-toggle" title="Back to Camera">
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M19 12H5"/>
              <path d="M12 19l-7-7 7-7"/>
            </svg>
          </button>
          <div></div>
        </div>
        <div class="qr-scanner-hint">Point at a friend's QR code</div>
      </div>
    `;

    attachQRListeners();
    startQRScanner();
  }

  function renderPhotoPreview() {
    container.innerHTML = `
      <div class="photo-preview">
        <div class="photo-preview-image">
          <img src="${capturedPhoto.preview}" alt="Captured photo">
          <div class="photo-preview-overlay">
            <input
              type="text"
              class="photo-text-input"
              id="text-overlay"
              placeholder="Add a message..."
              value="${textOverlay}"
              maxlength="100"
            >
          </div>
        </div>
        <div class="photo-controls">
          <button class="camera-btn" id="cancel-photo" title="Cancel">
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M18 6L6 18"/>
              <path d="M6 6l12 12"/>
            </svg>
          </button>
          <div class="timer-control">
            <span class="timer-label">Timer</span>
            <input
              type="range"
              class="timer-slider"
              id="timer-slider"
              min="1"
              max="10"
              value="${timerValue}"
            >
            <span class="timer-value" id="timer-value">${timerValue}s</span>
          </div>
          <button class="send-btn" id="send-btn" ${isSending ? 'disabled' : ''} title="Send">
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M22 2L11 13"/>
              <path d="M22 2l-7 20-4-9-9-4 20-7z"/>
            </svg>
          </button>
        </div>
        ${showFriendPicker ? renderFriendPicker() : ''}
      </div>
    `;

    attachPreviewListeners();
  }

  function renderFriendPicker() {
    const acceptedFriends = friends.filter(f => f.status === FriendStatus.ACCEPTED);

    return `
      <div class="friend-picker">
        <div class="friend-picker-header">
          <span class="friend-picker-title">Send to</span>
          <button class="friend-picker-close" id="close-picker">&times;</button>
        </div>
        <div class="friend-picker-list">
          ${acceptedFriends.length === 0 ? `
            <div class="empty-state">
              <div class="empty-state-text">No friends yet. Scan someone's QR code to add them!</div>
            </div>
          ` : acceptedFriends.map(friend => `
            <div class="friend-picker-item ${selectedFriend?.userId === friend.userId ? 'selected' : ''}" data-userid="${friend.userId}">
              <div class="friend-avatar">${friend.username.charAt(0).toUpperCase()}</div>
              <div class="friend-name">${friend.username}</div>
            </div>
          `).join('')}
        </div>
      </div>
    `;
  }

  function attachCameraListeners() {
    const qrToggle = container.querySelector('#qr-toggle');
    const flipBtn = container.querySelector('#flip-camera');
    const captureBtn = container.querySelector('#capture-btn');

    qrToggle?.addEventListener('click', () => {
      stopCamera();
      mode = 'qr';
      render();
    });

    flipBtn?.addEventListener('click', () => {
      facingMode = facingMode === 'user' ? 'environment' : 'user';
      startCamera();
    });

    captureBtn?.addEventListener('click', capturePhoto);
  }

  function attachQRListeners() {
    const qrToggle = container.querySelector('#qr-toggle');

    qrToggle?.addEventListener('click', () => {
      stopQRScanner();
      mode = 'photo';
      render();
    });
  }

  function attachPreviewListeners() {
    const cancelBtn = container.querySelector('#cancel-photo');
    const textInput = container.querySelector('#text-overlay');
    const timerSlider = container.querySelector('#timer-slider');
    const timerValueEl = container.querySelector('#timer-value');
    const sendBtn = container.querySelector('#send-btn');
    const closePicker = container.querySelector('#close-picker');
    const friendItems = container.querySelectorAll('.friend-picker-item');

    cancelBtn?.addEventListener('click', () => {
      capturedPhoto = null;
      textOverlay = '';
      selectedFriend = null;
      showFriendPicker = false;
      render();
    });

    textInput?.addEventListener('input', (e) => {
      textOverlay = e.target.value;
    });

    timerSlider?.addEventListener('input', (e) => {
      timerValue = parseInt(e.target.value, 10);
      if (timerValueEl) timerValueEl.textContent = `${timerValue}s`;
    });

    sendBtn?.addEventListener('click', () => {
      if (showFriendPicker && selectedFriend) {
        sendPhoto();
      } else {
        showFriendPicker = true;
        render();
      }
    });

    closePicker?.addEventListener('click', () => {
      showFriendPicker = false;
      selectedFriend = null;
      render();
    });

    friendItems.forEach(item => {
      item.addEventListener('click', () => {
        const userId = item.dataset.userid;
        const friend = friends.find(f => f.userId === userId);
        if (friend) {
          selectedFriend = friend;
          sendPhoto();
        }
      });
    });
  }

  async function startCamera() {
    try {
      // Stop existing stream
      if (stream) {
        stream.getTracks().forEach(track => track.stop());
      }

      stream = await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: facingMode,
          width: { ideal: 1280 },
          height: { ideal: 720 },
        },
        audio: false,
      });

      const video = container.querySelector('#camera-video');
      if (video) {
        video.srcObject = stream;
        // Mirror front-facing camera for natural selfie view
        video.classList.toggle('mirrored', facingMode === 'user');
      }
    } catch (err) {
      console.error('Camera error:', err);
      alert('Could not access camera. Please check permissions.');
    }
  }

  function stopCamera() {
    if (stream) {
      stream.getTracks().forEach(track => track.stop());
      stream = null;
    }
  }

  async function startQRScanner() {
    try {
      const qrReader = container.querySelector('#qr-reader');
      if (!qrReader) return;

      qrScanner = new Html5Qrcode('qr-reader');

      await qrScanner.start(
        { facingMode: 'environment' },
        {
          fps: 10,
          qrbox: { width: 250, height: 250 },
        },
        onQRCodeScanned,
        () => {} // Ignore errors during scanning
      );
    } catch (err) {
      console.error('QR Scanner error:', err);
      alert('Could not start QR scanner. Please check camera permissions.');
    }
  }

  async function stopQRScanner() {
    if (qrScanner) {
      try {
        await qrScanner.stop();
      } catch (err) {
        console.error('Error stopping QR scanner:', err);
      }
      qrScanner = null;
    }
  }

  async function onQRCodeScanned(decodedText) {
    // Validate it looks like a UUID
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (!uuidRegex.test(decodedText)) {
      return; // Ignore non-UUID QR codes
    }

    // Stop scanner
    await stopQRScanner();

    // Check if already a friend
    const existing = await friendStore.getFriend(decodedText);
    if (existing) {
      if (existing.status === FriendStatus.ACCEPTED) {
        alert(`Already friends with ${existing.username}!`);
      } else {
        alert(`Friend request already ${existing.status === FriendStatus.PENDING_SENT ? 'sent' : 'received'}!`);
      }
      mode = 'photo';
      render();
      return;
    }

    // Check it's not our own ID
    if (decodedText === client.getUserId()) {
      alert("That's your own QR code!");
      mode = 'photo';
      render();
      return;
    }

    // Send friend request
    try {
      await sendFriendRequest(decodedText);
      alert('Friend request sent!');
    } catch (err) {
      console.error('Failed to send friend request:', err);
      alert('Failed to send friend request: ' + err.message);
    }

    mode = 'photo';
    render();
  }

  async function sendFriendRequest(targetUserId) {
    await gateway.loadProto();

    const username = localStorage.getItem('obscura_username') || 'Unknown';

    // Encode friend request message
    const clientMessageBytes = gateway.encodeClientMessage({
      type: 'FRIEND_REQUEST',
      text: '',
      username: username,
    });

    // Encrypt and send
    const encrypted = await sessionManager.encrypt(targetUserId, clientMessageBytes);
    const protobufData = gateway.encodeOutgoingMessage(encrypted.body, encrypted.protoType);

    await client.sendMessage(targetUserId, protobufData);

    // Add to local friend store as pending_sent
    await friendStore.addFriend(targetUserId, 'Unknown', FriendStatus.PENDING_SENT);
    if (refreshFriends) refreshFriends();
  }

  function capturePhoto() {
    const video = container.querySelector('#camera-video');
    if (!video) return;

    const canvas = document.createElement('canvas');
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;

    const ctx = canvas.getContext('2d');

    // Mirror if front camera
    if (facingMode === 'user') {
      ctx.translate(canvas.width, 0);
      ctx.scale(-1, 1);
    }

    ctx.drawImage(video, 0, 0);

    canvas.toBlob((blob) => {
      if (blob) {
        capturedPhoto = {
          blob,
          preview: canvas.toDataURL('image/jpeg', 0.8),
        };
        stopCamera();
        render();
      }
    }, 'image/jpeg', 0.8);
  }

  async function sendPhoto() {
    if (!capturedPhoto || !selectedFriend || isSending) return;

    isSending = true;
    render();

    try {
      await gateway.loadProto();

      let clientMessageBytes;

      if (FEATURES.USE_ATTACHMENTS) {
        // Upload image as attachment, send reference
        const { id, expiresAt } = await client.uploadAttachment(capturedPhoto.blob);

        clientMessageBytes = gateway.encodeClientMessage({
          type: 'IMAGE',
          text: textOverlay,
          mimeType: 'image/jpeg',
          displayDuration: timerValue,
          attachmentId: id,
          attachmentExpires: expiresAt,
        });
      } else {
        // Legacy: send image bytes inline
        const arrayBuffer = await capturedPhoto.blob.arrayBuffer();
        const imageData = new Uint8Array(arrayBuffer);

        clientMessageBytes = gateway.encodeClientMessage({
          type: 'IMAGE',
          text: textOverlay,
          imageData: imageData,
          mimeType: 'image/jpeg',
          displayDuration: timerValue,
        });
      }

      // Encrypt and send
      const encrypted = await sessionManager.encrypt(selectedFriend.userId, clientMessageBytes);
      const protobufData = gateway.encodeOutgoingMessage(encrypted.body, encrypted.protoType);

      await client.sendMessage(selectedFriend.userId, protobufData);

      // Reset state
      capturedPhoto = null;
      textOverlay = '';
      selectedFriend = null;
      showFriendPicker = false;

      // Switch to inbox to show success
      if (onSwitchTab) onSwitchTab('inbox');
    } catch (err) {
      console.error('Failed to send photo:', err);
      alert('Failed to send: ' + err.message);
    } finally {
      isSending = false;
      render();
    }
  }

  // Cleanup function
  function cleanup() {
    stopCamera();
    stopQRScanner();
  }

  // Initial render
  render();

  return { cleanup, render };
}
