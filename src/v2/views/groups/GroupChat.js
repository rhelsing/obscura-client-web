/**
 * GroupChat View
 * - Group message list
 * - Send messages to group
 * - Voice memos (hold mic button to record)
 * - File/image/video/audio attachments
 */
import { navigate } from '../index.js';
import { parseMediaUrl, createMediaUrl, createChunkedMediaUrl } from '../../lib/attachmentUtils.js';
import { AudioRecorder, getMediaCategory, compressImage, gzipCompress, maybeDecompress, MAX_UPLOAD_SIZE, MAX_FILE_SIZE, convertHeicToJpeg, isHeic } from '../../lib/media.js';

let cleanup = null;
let messages = [];
let audioRecorder = null;
let isRecording = false;
let recordingStartTime = 0;

export function render({ group = null, messages = [], loading = false, sending = false, recording = false, recordingTime = 0 } = {}) {
  if (loading) {
    return `<div class="view group-chat"><div class="loading">Loading...</div></div>`;
  }

  if (!group) {
    return `<div class="view group-chat"><div class="error">Group not found</div></div>`;
  }

  const groupName = group.data?.name || 'Group';
  const members = parseMembers(group.data?.members);

  return `
    <div class="view group-chat">
      <header>
        <a href="/chats" data-navigo class="back"><ry-icon name="chevron-left"></ry-icon> Back</a>
        <div class="group-header">
          <h1>${escapeHtml(groupName)}</h1>
          <span class="member-count">${members.length} members</span>
        </div>
      </header>

      <div class="messages-container" id="messages">
        ${messages.length === 0 ? `
          <div class="empty">
            <p>No messages yet</p>
          </div>
        ` : `
          ${messages.map(m => `
            <div class="message ${m.fromMe ? 'sent' : 'received'}">
              ${!m.fromMe ? `<span class="author">${m.author || 'Unknown'}</span>` : ''}
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
                      <a href="#" class="file-download" data-dataurl="${m.fileDataUrl}" data-filename="${m.fileName || 'file'}">
                        file ${m.fileName || 'Download file'}
                      </a>
                    </div>
                  ` : `
                    <div class="attachment-content">${m.attachmentPreview || '[Attachment]'}</div>
                  `}
                </div>
              ` : `
                <div class="text">${escapeHtml(m.data?.text || m.text || '')}</div>
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
              placeholder="Message ${escapeHtml(groupName)}..."
              autocomplete="off"
              style="flex: 1"
              ${sending ? 'disabled' : ''}
            />
          `}
          <button type="button" variant="ghost" id="mic-btn" class="${recording ? 'recording' : ''}" ${sending ? 'disabled' : ''}>
            ${recording ? '<ry-icon name="check"></ry-icon>' : 'mic'}
          </button>
          <button type="submit" ${sending || recording ? 'disabled' : ''}>${sending ? '...' : 'Send'}</button>
        </ry-cluster>
      </form>

      <input type="file" id="file-input" accept="*/*" hidden />
    </div>
  `;
}

function escapeHtml(text) {
  if (!text) return '';
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

function formatTime(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function parseMembers(membersJson) {
  try {
    return JSON.parse(membersJson) || [];
  } catch {
    return [];
  }
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
  return `gmsg_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Resolve authorDeviceId to a username
 * @param {string} authorDeviceId - Device UUID of the author
 * @param {object} client - ObscuraClient instance
 * @returns {string} - Username or truncated ID
 */
function resolveAuthorName(authorDeviceId, client, profileMap = new Map()) {
  // Check if it's our own message
  if (authorDeviceId === client.deviceUUID) {
    return 'You';
  }

  // Check profile displayName first (from pre-loaded profiles)
  if (profileMap.has(authorDeviceId)) {
    return profileMap.get(authorDeviceId);
  }

  // Search through friends to find matching device
  if (client.friends && client.friends.friends) {
    for (const [username, data] of client.friends.friends) {
      if (data.devices) {
        for (const device of data.devices) {
          // Check both deviceUUID and serverUserId
          if (device.deviceUUID === authorDeviceId || device.serverUserId === authorDeviceId) {
            return username;
          }
        }
      }
    }
  }

  // Fallback: truncated ID
  return authorDeviceId?.slice(0, 8) || 'Unknown';
}

export async function mount(container, client, router, params) {
  const groupId = params.id;

  container.innerHTML = render({ loading: true });

  try {
    if (!client.group) {
      throw new Error('Group model not defined');
    }

    const group = await client.group.find(groupId);

    if (!group) {
      container.innerHTML = render({ group: null });
      return;
    }

    // Load profiles to get displayNames
    const profileMap = new Map();
    if (client.profile) {
      const profiles = await client.profile.where({}).exec();
      for (const p of profiles) {
        if (p.authorDeviceId && p.data?.displayName) {
          profileMap.set(p.authorDeviceId, p.data.displayName);
        }
      }
    }

    // Load messages
    messages = [];
    if (client.groupMessage) {
      const rawMessages = await client.groupMessage.where({
        'data.groupId': groupId
      }).orderBy('timestamp', 'asc').exec();

      // Mark which are from me, resolve author names, and parse attachments
      messages = rawMessages.map(m => {
        const mediaUrl = m.data?.mediaUrl;
        return {
          ...m,
          text: m.data?.text || '',
          fromMe: m.authorDeviceId === client.deviceUUID,
          author: resolveAuthorName(m.authorDeviceId, client, profileMap),
          attachment: !!mediaUrl,
          mediaUrl,
          downloaded: false,
        };
      });
    }

    // Track recording time
    let recordingTime = 0;
    let recordingTimer = null;

    container.innerHTML = render({ group, messages });

    const getMessagesContainer = () => container.querySelector('#messages');

    // Track initial load period (instant scroll for first 2 seconds)
    let isInitialLoad = true;
    setTimeout(() => { isInitialLoad = false; }, 2000);

    // Re-render while preserving scroll position
    const rerender = () => {
      const mc = getMessagesContainer();
      const scrollPos = mc ? mc.scrollTop : 0;
      container.innerHTML = render({ group, messages, recording: isRecording, recordingTime });
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
      const toDownload = messages.filter(m =>
        m.mediaUrl && !m.imageDataUrl && !m.audioDataUrl && !m.videoDataUrl && !m.fileDataUrl && !m.downloading
      );

      if (toDownload.length === 0) return;

      toDownload.forEach(m => m.downloading = true);
      rerender();
      attachListeners();

      await Promise.all(toDownload.map(async (m) => {
        try {
          const parsed = parseMediaUrl(m.mediaUrl);
          if (!parsed?.isRef) {
            m.downloading = false;
            return;
          }

          const isChunked = parsed.isChunked;
          const contentType = isChunked
            ? (parsed.ref.contentType || 'application/octet-stream')
            : (parsed.ref.contentType || 'image/jpeg');

          const onProgress = isChunked ? (progress) => {
            m.attachmentPreview = `Downloading ${progress.current}/${progress.total} chunks (${progress.percent}%)`;
            rerender();
          } : undefined;

          let decrypted = await client.attachments.downloadSmart(
            { isChunked, ref: parsed.ref },
            { onProgress }
          );

          decrypted = await maybeDecompress(decrypted);
          const blob = new Blob([decrypted], { type: contentType });
          const dataUrl = await blobToDataUrl(blob);

          const category = getMediaCategory(contentType);
          if (category === 'audio') {
            m.audioDataUrl = dataUrl;
          } else if (category === 'video') {
            m.videoDataUrl = dataUrl;
          } else if (category === 'image') {
            m.imageDataUrl = dataUrl;
          } else {
            m.fileDataUrl = dataUrl;
          }
          m.fileName = parsed.ref.fileName || m.fileName || 'file';
          m.downloading = false;
          m.downloaded = true;
          m.attachmentPreview = undefined;
        } catch (err) {
          console.error('[GroupChat] Failed to download attachment:', err);
          m.downloading = false;
          m.attachmentPreview = '[Failed to load]';
        }
      }));

      rerender();
      attachListeners();
      scrollToBottom();
    };

    // Send text message
    const handleSubmit = async (e) => {
      e.preventDefault();

      const inputEl = container.querySelector('#message-text');
      const text = inputEl.value.trim();
      if (!text) return;

      inputEl.value = '';

      // Optimistic UI
      messages.push({
        data: { text, groupId },
        text,
        fromMe: true,
        timestamp: Date.now()
      });
      rerender();
      scrollToBottom();
      attachListeners();

      const newInput = container.querySelector('#message-text');
      if (newInput) newInput.focus();

      try {
        await client.groupMessage.create({ groupId, text });
      } catch (err) {
        console.error('[GroupChat] Failed to send:', err);
      }
    };

    // File select handler
    async function handleFileSelect(e) {
      const input = e.target;
      const file = input.files[0];
      if (!file) return;

      try {
        let blob;
        let bytes;
        let contentType = file.type || 'application/octet-stream';

        // Convert HEIC/HEIF (iPhone camera photos) to JPEG
        if (isHeic(file)) {
          try {
            const result = await convertHeicToJpeg(file);
            blob = result.blob;
            if (!result.converted) {
              alert('HEIC images are not supported on this browser. Please convert to JPEG/PNG first, or use Safari.');
              input.value = '';
              return;
            }
            const buffer = await blob.arrayBuffer();
            bytes = new Uint8Array(buffer);
            contentType = 'image/jpeg';
          } catch (err) {
            console.error('[GroupChat Upload] HEIC conversion failed:', err);
            alert('Failed to convert HEIC image. Please convert to JPEG/PNG first.');
            input.value = '';
            return;
          }
        } else {
          const buffer = await file.arrayBuffer();
          bytes = new Uint8Array(buffer);
          blob = new Blob([bytes], { type: contentType });
        }

        // Compress images if too large
        if (contentType.startsWith('image/')) {
          const compressed = await compressImage(blob);
          if (compressed !== blob) {
            blob = compressed;
            bytes = new Uint8Array(await compressed.arrayBuffer());
            contentType = 'image/jpeg';
          }
        }

        // For non-images, try gzip compression if beneficial
        if (!contentType.startsWith('image/') && bytes.length > MAX_UPLOAD_SIZE && bytes.length < MAX_UPLOAD_SIZE * 2) {
          const { compressed, wasCompressed } = await gzipCompress(bytes);
          if (wasCompressed && compressed.length <= MAX_UPLOAD_SIZE) {
            bytes = compressed;
          }
        }

        // Check against max file size (100MB)
        if (bytes.length > MAX_FILE_SIZE) {
          const sizeMB = (bytes.length / (1024 * 1024)).toFixed(1);
          const limitMB = Math.round(MAX_FILE_SIZE / 1024 / 1024);
          alert(`File too large (${sizeMB}MB). Maximum size is ${limitMB}MB.`);
          input.value = '';
          return;
        }

        const isLargeFile = bytes.length > MAX_UPLOAD_SIZE;

        // Convert to data URL for immediate display (skip for very large files)
        let dataUrl = null;
        if (bytes.length < 10 * 1024 * 1024) {
          dataUrl = await blobToDataUrl(blob);
        }

        const timestamp = Date.now();
        const msgId = generateMsgId();
        const category = getMediaCategory(contentType);

        // Optimistic UI
        const msg = {
          id: msgId,
          attachment: true,
          fromMe: true,
          timestamp,
          fileName: file.name,
          uploadProgress: isLargeFile ? 0 : undefined,
        };

        if (dataUrl) {
          if (category === 'audio') msg.audioDataUrl = dataUrl;
          else if (category === 'video') msg.videoDataUrl = dataUrl;
          else if (category === 'image') msg.imageDataUrl = dataUrl;
          else msg.fileDataUrl = dataUrl;
        } else {
          msg.attachmentPreview = `Uploading ${file.name} (${(bytes.length / 1024 / 1024).toFixed(1)}MB)...`;
        }

        messages.push(msg);
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

        // Upload attachment (encrypt + upload to server)
        const result = await client.attachments.uploadSmart(
          new Blob([bytes], { type: contentType }),
          { contentType, fileName: file.name, onProgress }
        );
        const { isChunked, ref } = result;

        // Build mediaUrl JSON for persistence
        ref.fileName = file.name;
        const mediaUrl = isChunked
          ? createChunkedMediaUrl(ref)
          : createMediaUrl(ref);

        // Update optimistic message
        const targetMsg = messages.find(m => m.id === msgId);
        if (targetMsg) {
          targetMsg.mediaUrl = mediaUrl;
          targetMsg.uploadProgress = undefined;
          targetMsg.attachmentPreview = undefined;
          if (!targetMsg.imageDataUrl && !targetMsg.videoDataUrl && !targetMsg.audioDataUrl && !targetMsg.fileDataUrl) {
            const displayUrl = await blobToDataUrl(blob);
            if (category === 'audio') targetMsg.audioDataUrl = displayUrl;
            else if (category === 'video') targetMsg.videoDataUrl = displayUrl;
            else if (category === 'image') targetMsg.imageDataUrl = displayUrl;
            else targetMsg.fileDataUrl = displayUrl;
          }
          rerender();
        }

        // Create group message with mediaUrl via ORM (broadcasts to group members)
        await client.groupMessage.create({ groupId, text: '', mediaUrl });
        console.log('[GroupChat Upload] Attachment sent to group');

      } catch (err) {
        console.error('[GroupChat Upload] Failed:', err);
      }

      input.value = '';
    }

    // Audio recording functions
    async function startAudioRecording() {
      try {
        audioRecorder = new AudioRecorder();
        await audioRecorder.start();
        isRecording = true;
        recordingTime = 0;
        recordingStartTime = Date.now();

        recordingTimer = setInterval(() => {
          recordingTime = Math.floor((Date.now() - recordingStartTime) / 1000);
          rerender();
          attachListeners();
        }, 1000);

        rerender();
        attachListeners();
        console.log('[GroupChat Audio] Recording started');
      } catch (err) {
        console.error('[GroupChat Audio] Failed to start recording:', err);
        isRecording = false;
        audioRecorder = null;
      }
    }

    async function stopAudioRecording() {
      if (!isRecording || !audioRecorder) return;

      clearInterval(recordingTimer);
      recordingTimer = null;

      const { blob, contentType, duration } = await audioRecorder.stop();
      audioRecorder = null;
      isRecording = false;

      if (blob.size > 0) {
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
          // Upload audio (encrypt + upload to server)
          const ct = contentType || 'audio/webm';
          const result = await client.attachments.uploadSmart(
            new Blob([bytes], { type: ct }),
            { contentType: ct }
          );
          const { isChunked, ref } = result;

          const mediaUrl = isChunked
            ? createChunkedMediaUrl(ref)
            : createMediaUrl(ref);

          const targetMsg = messages.find(m => m.id === msgId);
          if (targetMsg) {
            targetMsg.mediaUrl = mediaUrl;
          }

          // Create group message with mediaUrl via ORM
          await client.groupMessage.create({ groupId, text: '', mediaUrl });
          console.log('[GroupChat Audio] Voice memo sent to group');
        } catch (err) {
          console.error('[GroupChat Audio] Failed to send:', err);
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
      if (newForm) newForm.addEventListener('submit', handleSubmit);

      // Re-attach attachment button and file input listeners
      const newAttachBtn = container.querySelector('#attach-btn');
      const newFileInput = container.querySelector('#file-input');

      if (newAttachBtn && newFileInput) {
        newAttachBtn.addEventListener('click', () => {
          newFileInput.click();
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

        micBtn.addEventListener('mousedown', handleMicDown);
        micBtn.addEventListener('mouseup', handleMicUp);
        micBtn.addEventListener('mouseleave', handleMicUp);

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

      // Scroll to bottom when images load
      container.querySelectorAll('.attachment-image').forEach(img => {
        if (!img.complete) {
          img.addEventListener('load', () => scrollToBottom());
        }
      });

      // File download click handlers
      container.querySelectorAll('.file-download').forEach(link => {
        link.addEventListener('click', (e) => {
          e.preventDefault();
          const dataUrl = link.dataset.dataurl;
          const filename = link.dataset.filename || 'file';

          try {
            const [header, base64] = dataUrl.split(',');
            const mimeMatch = header.match(/data:([^;]+)/);
            const mimeType = mimeMatch ? mimeMatch[1] : 'application/octet-stream';
            const binary = atob(base64);
            const bytes = new Uint8Array(binary.length);
            for (let i = 0; i < binary.length; i++) {
              bytes[i] = binary.charCodeAt(i);
            }
            const blob = new Blob([bytes], { type: mimeType });
            const blobUrl = URL.createObjectURL(blob);

            const tempLink = document.createElement('a');
            tempLink.href = blobUrl;
            tempLink.download = filename;
            tempLink.style.display = 'none';
            document.body.appendChild(tempLink);
            tempLink.click();
            document.body.removeChild(tempLink);

            setTimeout(() => URL.revokeObjectURL(blobUrl), 1000);
          } catch (err) {
            console.error('[GroupChat] Download failed:', err);
            window.open(dataUrl, '_blank');
          }
        });
      });

      router.updatePageLinks();
    }

    // Listen for new group messages (incoming sync)
    const handleSync = async (sync) => {
      if (sync.model === 'groupMessage') {
        // Reload messages from CRDT to pick up new entries
        const rawMessages = await client.groupMessage.where({
          'data.groupId': groupId
        }).orderBy('timestamp', 'asc').exec();

        messages = rawMessages.map(m => {
          const mediaUrl = m.data?.mediaUrl;
          // Preserve already-downloaded data URLs from existing messages
          const existing = messages.find(ex => ex.id === m.id);
          return {
            ...m,
            text: m.data?.text || '',
            fromMe: m.authorDeviceId === client.deviceUUID,
            author: resolveAuthorName(m.authorDeviceId, client, profileMap),
            attachment: !!mediaUrl,
            mediaUrl,
            downloaded: existing?.downloaded || false,
            audioDataUrl: existing?.audioDataUrl,
            videoDataUrl: existing?.videoDataUrl,
            imageDataUrl: existing?.imageDataUrl,
            fileDataUrl: existing?.fileDataUrl,
            fileName: existing?.fileName,
          };
        });

        rerender();
        attachListeners();
        scrollToBottom();
        downloadAttachments();
      }
    };

    client.on('modelSync', handleSync);

    attachListeners();
    scrollToBottom(true);

    // Start downloading any attachments that need loading
    downloadAttachments();

    cleanup = () => {
      client.off('modelSync', handleSync);

      // Clean up audio recording if in progress
      if (audioRecorder) {
        audioRecorder.cancel();
        audioRecorder = null;
      }
      clearInterval(recordingTimer);
      isRecording = false;
    };

  } catch (err) {
    container.innerHTML = `<div class="error">Failed to load group: ${err.message}</div>`;
  }
}

export function unmount() {
  if (cleanup) {
    cleanup();
    cleanup = null;
  }
}
