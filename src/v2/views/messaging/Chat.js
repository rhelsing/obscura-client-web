/**
 * Chat View
 * - Message list for a conversation
 * - Send text + attachments
 * - Audio messages (hold mic button to record)
 * - Real-time incoming messages
 *
 * IMPORTANT: Loads existing messages from client.messages on mount.
 * Also handles sentSync for messages sent from other devices.
 */
import { navigate, markConversationRead } from '../index.js';
import { parseMediaUrl, createMediaUrl } from '../../lib/attachmentUtils.js';
import { AudioRecorder, getMediaCategory, compressImage, gzipCompress, maybeDecompress, MAX_UPLOAD_SIZE, MAX_FILE_SIZE, convertHeicToJpeg, isHeic } from '../../lib/media.js';

let cleanup = null;
let messages = [];
let audioRecorder = null;
let isRecording = false;
let recordingStartTime = 0;

export function render({ username = '', displayName = '', messages = [], sending = false, streakCount = 0, recording = false, recordingTime = 0 } = {}) {
  const title = displayName || username;
  return `
    <div class="view chat">
      <header>
        <a href="/messages" data-navigo class="back"><ry-icon name="chevron-left"></ry-icon> Back</a>
        <cluster gap="xs" style="flex: 1; justify-content: center;">
          <h1>${title}</h1>
          ${streakCount > 0 ? `<span class="streak-badge">🔥 ${streakCount}</span>` : ''}
        </cluster>
        <a href="/profile/${username}" data-navigo><button variant="ghost" size="sm"><ry-icon name="user"></ry-icon></button></a>
      </header>

      <div class="messages-container" id="messages">
        ${messages.length === 0 ? `
          <div class="empty">
            <p>No messages yet. Say hello!</p>
          </div>
        ` : `
          ${messages.map(m => `
            <div class="message ${m.fromMe ? 'sent' : 'received'}">
              ${m.attachment ? `
                <div class="attachment">
                  ${m.uploadProgress !== undefined ? `
                    <div class="attachment-progress">
                      <div class="progress-bar" style="width: ${m.uploadProgress}%; background: var(--ry-color-primary); height: 4px; border-radius: 2px;"></div>
                      <div class="progress-text">${m.attachmentPreview || `Uploading ${m.uploadProgress}%`}</div>
                    </div>
                  ` : m.downloading ? `
                    <div class="attachment-loading">${m.attachmentPreview || 'Loading...'}</div>
                  ` : m.audioDataUrl ? `
                    <audio src="${m.audioDataUrl}" controls class="attachment-audio"></audio>
                  ` : m.videoDataUrl ? `
                    <video src="${m.videoDataUrl}" controls class="attachment-video" style="max-width: 100%; border-radius: 8px;"></video>
                  ` : m.imageDataUrl ? `
                    <img src="${m.imageDataUrl}" class="attachment-image" style="max-width: 100%; border-radius: 8px;" />
                  ` : m.fileDataUrl ? `
                    <div class="attachment-file">
                      <a href="${m.fileDataUrl}" download="${m.fileName || 'file'}" class="file-download">
                        📎 ${m.fileName || 'Download file'}
                      </a>
                    </div>
                  ` : `
                    <div class="attachment-content">${m.attachmentPreview || '[Attachment]'}</div>
                  `}
                </div>
              ` : `
                <div class="text">${escapeHtml(m.text)}</div>
              `}
              <div class="time">${formatTime(m.timestamp)}</div>
            </div>
          `).join('')}
        `}
      </div>

      <form id="message-form" class="message-input">
        <ry-cluster>
          <button type="button" variant="ghost" id="attach-btn" ${sending || recording ? 'disabled' : ''}><ry-icon name="upload"></ry-icon></button>
          ${recording ? `
            <div class="recording-indicator" style="flex: 1; display: flex; align-items: center; gap: 8px;">
              <span class="recording-dot"></span>
              <span>${Math.floor(recordingTime / 60)}:${String(recordingTime % 60).padStart(2, '0')}</span>
              <span style="color: var(--ry-color-text-muted)">Release to send</span>
            </div>
          ` : `
            <input
              type="text"
              id="message-text"
              placeholder="Type a message..."
              autocomplete="off"
              style="flex: 1"
              ${sending ? 'disabled' : ''}
            />
          `}
          <button type="button" variant="ghost" id="mic-btn" class="${recording ? 'recording' : ''}" ${sending ? 'disabled' : ''}>
            ${recording ? '<ry-icon name="check"></ry-icon>' : '🎤'}
          </button>
          <button type="submit" ${sending || recording ? 'disabled' : ''}>${sending ? '...' : 'Send'}</button>
        </ry-cluster>
      </form>

      <input type="file" id="file-input" accept="*/*" hidden />
    </div>
  `;
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

function formatTime(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

// Helper: Convert blob to data URL
function blobToDataUrl(blob) {
  return new Promise(resolve => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.readAsDataURL(blob);
  });
}


// Helper: Generate unique message ID
function generateMsgId() {
  return `msg_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

export async function mount(container, client, router, params) {
  const username = params.username;

  // Mark conversation as read
  markConversationRead(username);

  // Look up displayName from profiles
  let displayName = null;
  if (client.profile && client.friends?.friends) {
    const friend = client.friends.friends.get(username);
    if (friend?.devices) {
      try {
        const profiles = await client.profile.where({}).exec();
        const profileMap = new Map(profiles.map(p => [p.authorDeviceId, p.data?.displayName]));
        for (const device of friend.devices) {
          if (device.deviceUUID && profileMap.has(device.deviceUUID)) {
            displayName = profileMap.get(device.deviceUUID);
            break;
          }
        }
      } catch (err) {
        console.warn('Failed to load profile for chat:', err);
      }
    }
  }

  // Query streak from PixRegistry for this friend
  let streakCount = 0;
  if (client.pixRegistry) {
    try {
      const registry = await client.pixRegistry
        .where({ 'data.friendUsername': username })
        .first();
      streakCount = registry?.data?.streakCount || 0;
    } catch (err) {
      console.warn('Failed to load pix registry:', err);
    }
  }

  // Show loading state first
  container.innerHTML = render({ username, displayName, messages: [], sending: false, streakCount });

  // Load existing messages from IndexedDB (or in-memory fallback)
  try {
    const stored = await client.getMessages(username);
    messages = stored.map(m => {
      // Convert old contentReference to mediaUrl if needed
      let mediaUrl = m.mediaUrl;
      if (!mediaUrl && m.contentReference) {
        mediaUrl = createMediaUrl(m.contentReference);
      }
      return {
        text: m.text || m.content || '',
        fromMe: m.isSent,
        timestamp: m.timestamp,
        attachment: !!mediaUrl,
        mediaUrl,
        downloaded: false,
      };
    });
  } catch (err) {
    console.error('Failed to load messages:', err);
    // Fallback to in-memory
    messages = (client.messages || [])
      .filter(m => m.from === username || m.to === username || m.conversationId === username)
      .map(m => {
        let mediaUrl = m.mediaUrl;
        if (!mediaUrl && m.contentReference) {
          mediaUrl = createMediaUrl(m.contentReference);
        }
        return {
          text: m.text || (m.content ? (typeof m.content === 'string' ? m.content : new TextDecoder().decode(m.content)) : ''),
          fromMe: m.isSent || m.to === username,
          timestamp: m.timestamp,
          attachment: !!mediaUrl,
          mediaUrl,
          downloaded: false,
        };
      })
      .sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));
  }

  container.innerHTML = render({ username, displayName, messages, streakCount });

  // Get messagesContainer and helpers
  const getMessagesContainer = () => container.querySelector('#messages');

  // Track initial load period (instant scroll for first 2 seconds)
  let isInitialLoad = true;
  setTimeout(() => { isInitialLoad = false; }, 2000);

  // Track recording time
  let recordingTime = 0;
  let recordingTimer = null;

  // Re-render while preserving scroll position
  const rerender = () => {
    const mc = getMessagesContainer();
    const scrollPos = mc ? mc.scrollTop : 0;
    container.innerHTML = render({ username, displayName, messages, streakCount, recording: isRecording, recordingTime });
    const newMc = getMessagesContainer();
    if (newMc) newMc.scrollTop = scrollPos;
  };

  const scrollToBottom = (instant = false) => {
    const useInstant = instant || isInitialLoad;
    requestAnimationFrame(() => {
      const mc = getMessagesContainer();
      if (!mc) return;
      if (useInstant) {
        mc.scrollTop = mc.scrollHeight;
      } else {
        mc.scrollTo({ top: mc.scrollHeight, behavior: 'smooth' });
      }
    });
  };

  // Auto-download any attachments that need loading
  const downloadAttachments = async () => {
    // Collect all messages needing download first (avoid modifying during iteration)
    // Check all media types
    const toDownload = messages.filter(m =>
      m.mediaUrl && !m.imageDataUrl && !m.audioDataUrl && !m.videoDataUrl && !m.fileDataUrl && !m.downloading
    );

    if (toDownload.length === 0) return;

    // Mark all as downloading, single render
    toDownload.forEach(m => m.downloading = true);
    rerender();
    attachListeners();

    // Download all in parallel
    await Promise.all(toDownload.map(async (m) => {
      try {
        const parsed = parseMediaUrl(m.mediaUrl);
        if (!parsed?.isRef) {
          m.downloading = false;
          return;
        }

        // Use smart download for both single and chunked attachments
        const isChunked = parsed.isChunked;
        const contentType = isChunked
          ? (parsed.ref.contentType || 'application/octet-stream')
          : (parsed.ref.contentType || 'image/jpeg');

        // Progress callback for chunked downloads
        const onProgress = isChunked ? (progress) => {
          m.attachmentPreview = `Downloading ${progress.current}/${progress.total} chunks (${progress.percent}%)`;
          rerender();
        } : undefined;

        let decrypted = await client.attachments.downloadSmart(
          { isChunked, ref: parsed.ref },
          { onProgress }
        );

        // Auto-decompress if gzipped (detected via magic bytes)
        decrypted = await maybeDecompress(decrypted);
        console.log('[Chat] Downloaded attachment, contentType:', contentType, isChunked ? '(chunked)' : '');
        const blob = new Blob([decrypted], { type: contentType });
        const dataUrl = await blobToDataUrl(blob);

        // Set appropriate data URL based on content type
        const category = getMediaCategory(contentType);
        console.log('[Chat] Media category:', category, 'fileName:', parsed.ref.fileName);
        if (category === 'audio') {
          m.audioDataUrl = dataUrl;
        } else if (category === 'video') {
          m.videoDataUrl = dataUrl;
        } else if (category === 'image') {
          m.imageDataUrl = dataUrl;
        } else {
          // Generic file - store for download
          m.fileDataUrl = dataUrl;
        }
        // Always preserve fileName if present
        m.fileName = parsed.ref.fileName || m.fileName || 'file';
        m.downloading = false;
        m.downloaded = true;
        m.attachmentPreview = undefined; // Clear progress
      } catch (err) {
        console.error('Failed to download attachment:', err);
        m.downloading = false;
        m.attachmentPreview = '[Failed to load]';
      }
    }));

    // Single re-render after all downloads complete
    rerender();
    attachListeners();
    scrollToBottom();
  };

  const form = container.querySelector('#message-form');
  const input = container.querySelector('#message-text');
  const attachBtn = container.querySelector('#attach-btn');
  const fileInput = container.querySelector('#file-input');
  const messagesContainer = getMessagesContainer();

  // Send message
  const handleSubmit = async (e) => {
    e.preventDefault();

    // Query input fresh each time (in case DOM was re-rendered)
    const inputEl = container.querySelector('#message-text');
    const text = inputEl.value.trim();
    if (!text) return;

    inputEl.value = '';

    // Optimistic UI update
    messages.push({
      text,
      fromMe: true,
      timestamp: Date.now()
    });
    rerender();
    scrollToBottom();
    attachListeners();

    // Re-focus the input after re-render
    const newInput = container.querySelector('#message-text');
    if (newInput) newInput.focus();

    try {
      await client.send(username, { text });
    } catch (err) {
      console.error('Failed to send:', err);
      if (typeof RyToast !== 'undefined') {
        RyToast.error(err.message || 'Failed to send message');
      }
    }
  };

  form.addEventListener('submit', handleSubmit);

  // File select handler (used by attachListeners)
  async function handleFileSelect(e) {
    const input = e.target;
    console.log('[Upload] File input change event fired');
    const file = input.files[0];
    console.log('[Upload] Got file:', file ? `${file.name} (${file.size} bytes, type: ${file.type})` : 'NO FILE');
    if (!file) {
      console.log('[Upload] ABORT: No file selected');
      return;
    }

    try {
      let blob;
      let bytes;
      let contentType = file.type || 'application/octet-stream';

      // Convert HEIC/HEIF (iPhone camera photos) to JPEG
      if (isHeic(file)) {
        console.log('[Upload] Converting HEIC/HEIF to JPEG');
        try {
          const result = await convertHeicToJpeg(file);
          blob = result.blob;
          if (!result.converted) {
            // Conversion failed - HEIC not supported on this browser
            alert('HEIC images are not supported on this browser. Please convert to JPEG/PNG first, or use Safari.');
            input.value = '';
            return;
          }
          const buffer = await blob.arrayBuffer();
          bytes = new Uint8Array(buffer);
          contentType = 'image/jpeg';
        } catch (err) {
          console.error('[Upload] HEIC conversion failed:', err);
          alert('Failed to convert HEIC image. Please convert to JPEG/PNG first.');
          input.value = '';
          return;
        }
      } else {
        // Read any file type (image, video, audio, generic file)
        console.log('[Upload] Reading file as ArrayBuffer');
        const buffer = await file.arrayBuffer();
        bytes = new Uint8Array(buffer);
        blob = new Blob([bytes], { type: contentType });
      }
      console.log('[Upload] File ready:', bytes.length, 'bytes, type:', contentType);

      // Compress images if too large
      if (contentType.startsWith('image/')) {
        const compressed = await compressImage(blob);
        if (compressed !== blob) {
          blob = compressed;
          bytes = new Uint8Array(await compressed.arrayBuffer());
          contentType = 'image/jpeg'; // compressImage outputs JPEG
          console.log('[Upload] After compression:', bytes.length, 'bytes');
        }
      }

      // For non-images, try gzip compression if beneficial
      if (!contentType.startsWith('image/') && bytes.length > MAX_UPLOAD_SIZE && bytes.length < MAX_UPLOAD_SIZE * 2) {
        console.log(`[Upload] Non-image file over ${MAX_UPLOAD_SIZE / 1024}KB, trying gzip...`);
        const { compressed, wasCompressed } = await gzipCompress(bytes);
        if (wasCompressed && compressed.length <= MAX_UPLOAD_SIZE) {
          bytes = compressed;
          console.log(`[Upload] Gzip succeeded: ${compressed.length} bytes`);
        }
      }

      // Check against max file size (100MB) - chunked upload handles large files
      if (bytes.length > MAX_FILE_SIZE) {
        const sizeMB = (bytes.length / (1024 * 1024)).toFixed(1);
        const limitMB = Math.round(MAX_FILE_SIZE / 1024 / 1024);
        alert(`File too large (${sizeMB}MB). Maximum size is ${limitMB}MB.`);
        input.value = '';
        return;
      }

      // Track if this is a large file that will use chunked upload
      const isLargeFile = bytes.length > MAX_UPLOAD_SIZE;

      // Convert to data URL for immediate display (skip for very large files to save memory)
      let dataUrl = null;
      if (bytes.length < 10 * 1024 * 1024) { // Only create preview for files under 10MB
        dataUrl = await blobToDataUrl(blob);
      }

      const timestamp = Date.now();
      const msgId = generateMsgId();
      const category = getMediaCategory(contentType);

      // Optimistic UI - show based on file type
      const msg = {
        id: msgId,
        attachment: true,
        fromMe: true,
        timestamp,
        fileName: file.name,
        uploadProgress: isLargeFile ? 0 : undefined, // Track progress for large files
      };

      // Set the appropriate data URL field based on category
      if (dataUrl) {
        if (category === 'audio') {
          msg.audioDataUrl = dataUrl;
        } else if (category === 'video') {
          msg.videoDataUrl = dataUrl;
        } else if (category === 'image') {
          msg.imageDataUrl = dataUrl;
        } else {
          msg.fileDataUrl = dataUrl;
        }
      } else {
        // Large file - show placeholder
        msg.attachmentPreview = `Uploading ${file.name} (${(bytes.length / 1024 / 1024).toFixed(1)}MB)...`;
      }

      messages.push(msg);
      console.log('[Upload] UI updated with', category, 'attachment', isLargeFile ? '(chunked)' : '');
      rerender();
      scrollToBottom();
      attachListeners();

      // Progress callback for large files
      const onProgress = isLargeFile ? (progress) => {
        const targetMsg = messages.find(m => m.id === msgId);
        if (targetMsg) {
          targetMsg.uploadProgress = progress.percent;
          targetMsg.attachmentPreview = `Uploading ${progress.current}/${progress.total} chunks (${progress.percent}%)`;
          rerender();
        }
      } : undefined;

      // Send and get mediaUrl back (JSON string)
      console.log('[Upload] Calling sendAttachment to', username, isLargeFile ? '(chunked)' : '');
      const mediaUrl = await client.sendAttachment(username, bytes, { contentType, fileName: file.name, onProgress });

      // Parse and add filename to the mediaUrl for persistence
      const parsed = parseMediaUrl(mediaUrl);
      if (parsed?.ref) {
        parsed.ref.fileName = file.name;
      }

      // Handle both chunked and single attachments
      const isChunked = parsed?.isChunked;
      const refId = isChunked ? parsed?.ref?.fileId : parsed?.ref?.attachmentId;
      const mediaUrlWithName = parsed ? (isChunked
        ? JSON.stringify({ ...parsed.ref, fileName: file.name })
        : JSON.stringify(parsed.ref)) : mediaUrl;

      console.log('[Upload] sendAttachment returned:', refId || 'NO REF', isChunked ? '(chunked)' : '');

      // Store to IndexedDB with mediaUrl for persistence
      if (mediaUrlWithName && refId) {
        const targetMsg = messages.find(m => m.id === msgId);
        if (targetMsg) {
          targetMsg.mediaUrl = mediaUrlWithName;
          targetMsg.uploadProgress = undefined; // Clear progress
          targetMsg.attachmentPreview = undefined;
          // Reload dataUrl if we skipped it earlier
          if (!targetMsg.imageDataUrl && !targetMsg.videoDataUrl && !targetMsg.audioDataUrl && !targetMsg.fileDataUrl) {
            const displayUrl = await blobToDataUrl(blob);
            if (category === 'audio') targetMsg.audioDataUrl = displayUrl;
            else if (category === 'video') targetMsg.videoDataUrl = displayUrl;
            else if (category === 'image') targetMsg.imageDataUrl = displayUrl;
            else targetMsg.fileDataUrl = displayUrl;
          }
          rerender();
        }
        await client.messageStore.addMessage(username, {
          messageId: `att_${refId}`,
          content: '',
          mediaUrl: mediaUrlWithName,
          isSent: true,
          timestamp,
        });
        console.log('[Upload] Persisted to IndexedDB');
      }

      console.log('[Upload] COMPLETE: Attachment sent successfully');

    } catch (err) {
      console.error('[Upload] ERROR at step:', err.message);
      console.error('Failed to send attachment:', err);
    }

    input.value = '';
  }

  // Initial attachment listeners (will be re-attached by attachListeners on re-render)
  attachBtn.addEventListener('click', () => {
    console.log('[Upload] Step 1: Attach button clicked');
    console.log('[Upload] Step 2: Calling fileInput.click()');
    fileInput.click();
    console.log('[Upload] Step 3: fileInput.click() called - file dialog should open');
  });
  fileInput.addEventListener('change', handleFileSelect);

  // Incoming messages
  const handleMessage = (msg) => {
    if (msg.from === username || msg.conversationId === username) {
      messages.push({
        text: msg.text,
        fromMe: false,
        timestamp: msg.timestamp || Date.now()
      });
      rerender();
      scrollToBottom(true); // instant scroll for incoming messages
      attachListeners();
    }
  };

  // Incoming attachments - auto-download and display
  const handleAttachment = async (att) => {
    // att.from is serverUserId (UUID), need to check if it matches this friend
    const friend = client.friends.get(username);
    const isFromFriend = friend?.devices?.some(d => d.serverUserId === att.from);
    if (isFromFriend) {
      // Convert contentReference to mediaUrl (includes fileName from proto)
      const mediaUrl = createMediaUrl(att.contentReference);

      // Add message with loading state (use ID instead of index)
      const msgId = generateMsgId();
      const msg = {
        id: msgId,
        attachment: true,
        mediaUrl,
        fileName: att.contentReference?.fileName || '', // Extract fileName from proto
        downloading: true,
        fromMe: false,
        timestamp: Date.now()
      };
      messages.push(msg);
      rerender();
      scrollToBottom();
      attachListeners();

      // Auto-download and display
      try {
        let decrypted = await client.attachments.download(att.contentReference);
        // Auto-decompress if gzipped (detected via magic bytes)
        decrypted = await maybeDecompress(decrypted);
        const contentType = att.contentReference?.contentType || 'image/jpeg';
        const blob = new Blob([decrypted], { type: contentType });
        const dataUrl = await blobToDataUrl(blob);

        // Find message by ID (safe even if array modified)
        const targetMsg = messages.find(m => m.id === msgId);
        if (targetMsg) {
          targetMsg.downloading = false;
          const category = getMediaCategory(contentType);
          if (category === 'audio') {
            targetMsg.audioDataUrl = dataUrl;
          } else if (category === 'video') {
            targetMsg.videoDataUrl = dataUrl;
          } else if (category === 'file') {
            targetMsg.fileDataUrl = dataUrl;
            // fileName already set from att.contentReference.fileName
          } else {
            targetMsg.imageDataUrl = dataUrl;
          }
          targetMsg.downloaded = true;
        }
        rerender();
        attachListeners();
        scrollToBottom();
        // Note: Message already persisted by ObscuraClient._persistMessage() with contentReference
      } catch (err) {
        console.error('Failed to download attachment:', err);
        const targetMsg = messages.find(m => m.id === msgId);
        if (targetMsg) {
          targetMsg.downloading = false;
          targetMsg.attachmentPreview = '[Failed to load]';
        }
        rerender();
        attachListeners();
      }
    }
  };

  // Sent sync - messages sent from another device
  const handleSentSync = async (sync) => {
    if (sync.conversationId === username) {
      // Decode content if it's a Uint8Array
      let text = '';
      if (sync.content) {
        text = sync.content instanceof Uint8Array
          ? new TextDecoder().decode(sync.content)
          : String(sync.content);
      }

      // Use mediaUrl from sync (now a JSON string)
      const mediaUrl = sync.mediaUrl;
      const hasAttachment = !!mediaUrl;

      const msgId = generateMsgId();
      const msg = {
        id: msgId,
        text,
        fromMe: true,
        timestamp: sync.timestamp || Date.now(),
        attachment: hasAttachment,
        mediaUrl,
        downloading: hasAttachment,
        downloaded: false,
      };
      messages.push(msg);
      rerender();
      scrollToBottom();
      attachListeners();

      // Auto-download if has attachment
      if (mediaUrl) {
        try {
          const parsed = parseMediaUrl(mediaUrl);
          if (parsed?.isRef) {
            let decrypted = await client.attachments.download(parsed.ref);
            // Auto-decompress if gzipped
            decrypted = await maybeDecompress(decrypted);
            const contentType = parsed.ref.contentType || 'image/jpeg';
            const blob = new Blob([decrypted], { type: contentType });
            const dataUrl = await blobToDataUrl(blob);

            const targetMsg = messages.find(m => m.id === msgId);
            if (targetMsg) {
              targetMsg.downloading = false;
              const category = getMediaCategory(contentType);
              if (category === 'audio') {
                targetMsg.audioDataUrl = dataUrl;
              } else if (category === 'video') {
                targetMsg.videoDataUrl = dataUrl;
              } else {
                targetMsg.imageDataUrl = dataUrl;
              }
              targetMsg.downloaded = true;
            }
            rerender();
            attachListeners();
            scrollToBottom();
          }
        } catch (err) {
          console.error('Failed to download synced attachment:', err);
          const targetMsg = messages.find(m => m.id === msgId);
          if (targetMsg) {
            targetMsg.downloading = false;
            targetMsg.attachmentPreview = '[Failed to load]';
          }
          rerender();
          attachListeners();
        }
      }
    }
  };

  // Handle messages migrated from unknown device to this conversation
  // This happens when a DEVICE_ANNOUNCE reveals messages that were stored under a serverUserId
  const handleMessagesMigrated = async (event) => {
    if (event.conversationId === username) {
      console.log(`[Chat] ${event.count} messages migrated to this conversation, reloading`);
      // Reload messages from IndexedDB
      try {
        const stored = await client.getMessages(username);
        messages = stored.map(m => {
          let mediaUrl = m.mediaUrl;
          if (!mediaUrl && m.contentReference) {
            mediaUrl = createMediaUrl(m.contentReference);
          }
          return {
            text: m.text || m.content || '',
            fromMe: m.isSent,
            timestamp: m.timestamp,
            attachment: !!mediaUrl,
            mediaUrl,
            downloaded: false,
          };
        });
        rerender();
        attachListeners();
        scrollToBottom();
        downloadAttachments();
      } catch (err) {
        console.error('Failed to reload messages after migration:', err);
      }
    }
  };

  client.on('message', handleMessage);
  client.on('attachment', handleAttachment);
  client.on('sentSync', handleSentSync);
  client.on('messagesMigrated', handleMessagesMigrated);

  // Audio recording functions
  async function startAudioRecording() {
    try {
      audioRecorder = new AudioRecorder();
      await audioRecorder.start();
      isRecording = true;
      recordingTime = 0;
      recordingStartTime = Date.now();

      // Update timer every second
      recordingTimer = setInterval(() => {
        recordingTime = Math.floor((Date.now() - recordingStartTime) / 1000);
        rerender();
        attachListeners();
      }, 1000);

      rerender();
      attachListeners();
      console.log('[Audio] Recording started');
    } catch (err) {
      console.error('[Audio] Failed to start recording:', err);
      isRecording = false;
      audioRecorder = null;
    }
  }

  async function stopAudioRecording() {
    if (!isRecording || !audioRecorder) return;

    clearInterval(recordingTimer);
    recordingTimer = null;

    console.log('[Audio] Stopping recording...');
    const { blob, contentType, duration } = await audioRecorder.stop();
    audioRecorder = null;
    isRecording = false;

    console.log('[Audio] Recording stopped, blob size:', blob.size);

    if (blob.size > 0) {
      // Send the audio message
      const bytes = new Uint8Array(await blob.arrayBuffer());
      const audioDataUrl = await blobToDataUrl(blob);
      const msgId = generateMsgId();

      // Optimistic UI
      messages.push({
        id: msgId,
        attachment: true,
        audioDataUrl,
        fromMe: true,
        timestamp: Date.now()
      });
      rerender();
      scrollToBottom();
      attachListeners();

      try {
        // Send audio attachment (handles upload, encryption, and fan-out)
        const mediaUrl = await client.sendAttachment(username, bytes, {
          contentType: contentType || 'audio/webm'
        });

        // Update message with mediaUrl for persistence
        const targetMsg = messages.find(m => m.id === msgId);
        if (targetMsg) {
          targetMsg.mediaUrl = mediaUrl;
        }

        // Persist to IndexedDB
        const parsed = parseMediaUrl(mediaUrl);
        console.log('[Audio] mediaUrl to persist:', mediaUrl);
        console.log('[Audio] parsed.ref.contentType:', parsed?.ref?.contentType);
        if (parsed?.ref?.attachmentId) {
          await client.messageStore.addMessage(username, {
            messageId: `audio_${parsed.ref.attachmentId}`,
            content: '',
            mediaUrl,
            isSent: true,
            timestamp: Date.now(),
          });
        }

        console.log('[Audio] Audio message sent and persisted');
      } catch (err) {
        console.error('[Audio] Failed to send:', err);
      }
    }

    rerender();
    attachListeners();
  }

  function cancelAudioRecording() {
    if (audioRecorder) {
      audioRecorder.cancel();
      audioRecorder = null;
    }
    clearInterval(recordingTimer);
    recordingTimer = null;
    isRecording = false;
    recordingTime = 0;
    rerender();
    attachListeners();
  }

  function attachListeners() {
    // Re-attach form listener after re-render
    const newForm = container.querySelector('#message-form');
    newForm.addEventListener('submit', handleSubmit);

    // Re-attach attachment button and file input listeners
    const newAttachBtn = container.querySelector('#attach-btn');
    const newFileInput = container.querySelector('#file-input');

    if (newAttachBtn) {
      newAttachBtn.addEventListener('click', () => {
        console.log('[Upload] Step 1: Attach button clicked');
        console.log('[Upload] Step 2: Calling fileInput.click()');
        newFileInput.click();
        console.log('[Upload] Step 3: fileInput.click() called - file dialog should open');
      });
    }

    if (newFileInput) {
      newFileInput.addEventListener('change', handleFileSelect);
    }

    // Mic button for audio recording (press and hold)
    const micBtn = container.querySelector('#mic-btn');
    if (micBtn) {
      const handleMicDown = (e) => {
        e.preventDefault();
        if (!isRecording) {
          startAudioRecording();
        }
      };

      const handleMicUp = (e) => {
        e.preventDefault();
        if (isRecording) {
          stopAudioRecording();
        }
      };

      // Mouse events
      micBtn.addEventListener('mousedown', handleMicDown);
      micBtn.addEventListener('mouseup', handleMicUp);
      micBtn.addEventListener('mouseleave', handleMicUp);

      // Touch events
      micBtn.addEventListener('touchstart', handleMicDown, { passive: false });
      micBtn.addEventListener('touchend', handleMicUp, { passive: false });
      micBtn.addEventListener('touchcancel', handleMicUp, { passive: false });

      // Document-level listeners for when button DOM changes during recording
      const documentMouseUp = () => {
        if (isRecording) {
          stopAudioRecording();
          document.removeEventListener('mouseup', documentMouseUp);
        }
      };
      const documentTouchEnd = () => {
        if (isRecording) {
          stopAudioRecording();
          document.removeEventListener('touchend', documentTouchEnd);
        }
      };
      if (isRecording) {
        document.addEventListener('mouseup', documentMouseUp);
        document.addEventListener('touchend', documentTouchEnd);
      }
    }

    // Scroll to bottom when images load (they change container height)
    container.querySelectorAll('.attachment-image').forEach(img => {
      if (!img.complete) {
        img.addEventListener('load', () => scrollToBottom());
      }
    });

    // Download buttons
    container.querySelectorAll('.download-btn').forEach(btn => {
      btn.addEventListener('click', async () => {
        const ref = btn.dataset.ref;
        try {
          btn.textContent = 'Downloading...';
          const data = await client.attachments.download(ref);
          // For now just show size
          const msg = messages.find(m => m.attachment === ref);
          if (msg) {
            msg.downloaded = true;
            msg.attachmentPreview = `[${data.length} bytes]`;
          }
          rerender();
          attachListeners();
        } catch (err) {
          btn.textContent = 'Failed';
        }
      });
    });

    router.updatePageLinks();
  }

  attachListeners();
  scrollToBottom(true);  // instant on page load

  // Start downloading any attachments that need loading
  downloadAttachments();

  cleanup = () => {
    client.off('message', handleMessage);
    client.off('attachment', handleAttachment);
    client.off('sentSync', handleSentSync);
    client.off('messagesMigrated', handleMessagesMigrated);

    // Clean up audio recording if in progress
    if (audioRecorder) {
      audioRecorder.cancel();
      audioRecorder = null;
    }
    clearInterval(recordingTimer);
    isRecording = false;
  };
}

export function unmount() {
  if (cleanup) {
    cleanup();
    cleanup = null;
  }
}
