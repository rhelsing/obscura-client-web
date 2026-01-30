/**
 * Chat View
 * - Message list for a conversation
 * - Send text + attachments
 * - Real-time incoming messages
 *
 * IMPORTANT: Loads existing messages from client.messages on mount.
 * Also handles sentSync for messages sent from other devices.
 */
import { navigate } from '../index.js';

let cleanup = null;
let messages = [];

export function render({ username = '', displayName = '', messages = [], sending = false, streakCount = 0 } = {}) {
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
                  ${m.downloading ? `
                    <div class="attachment-loading">Loading...</div>
                  ` : m.imageDataUrl ? `
                    <img src="${m.imageDataUrl}" class="attachment-image" style="max-width: 100%; border-radius: 8px;" />
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
          <button type="button" variant="ghost" id="attach-btn" ${sending ? 'disabled' : ''}><ry-icon name="upload"></ry-icon></button>
          <input
            type="text"
            id="message-text"
            placeholder="Type a message..."
            autocomplete="off"
            style="flex: 1"
            ${sending ? 'disabled' : ''}
          />
          <button type="submit" ${sending ? 'disabled' : ''}>${sending ? '...' : 'Send'}</button>
        </ry-cluster>
      </form>

      <input type="file" id="file-input" hidden />
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

export async function mount(container, client, router, params) {
  const username = params.username;

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
    messages = stored.map(m => ({
      text: m.text || m.content || '',
      fromMe: m.isSent,
      timestamp: m.timestamp,
      attachment: m.contentReference || m.attachment,
      contentReference: m.contentReference,
      downloaded: false,
    }));
  } catch (err) {
    console.error('Failed to load messages:', err);
    // Fallback to in-memory
    messages = (client.messages || [])
      .filter(m => m.from === username || m.to === username || m.conversationId === username)
      .map(m => ({
        text: m.text || (m.content ? (typeof m.content === 'string' ? m.content : new TextDecoder().decode(m.content)) : ''),
        fromMe: m.isSent || m.to === username,
        timestamp: m.timestamp,
        attachment: m.contentReference || m.attachment,
        contentReference: m.contentReference,
        downloaded: false,
      }))
      .sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));
  }

  container.innerHTML = render({ username, displayName, messages, streakCount });

  // Get messagesContainer and define scrollToBottom BEFORE downloadAttachments
  const getMessagesContainer = () => container.querySelector('#messages');
  const scrollToBottom = () => {
    const mc = getMessagesContainer();
    if (mc) mc.scrollTop = mc.scrollHeight;
  };

  // Auto-download any attachments that need loading
  const downloadAttachments = async () => {
    for (let i = 0; i < messages.length; i++) {
      const m = messages[i];
      if (m.contentReference && !m.imageDataUrl && !m.downloading) {
        m.downloading = true;
        container.innerHTML = render({ username, displayName, messages, streakCount });
        try {
          const decrypted = await client.attachments.download(m.contentReference);
          const blob = new Blob([decrypted], { type: 'image/jpeg' });
          const dataUrl = await new Promise(resolve => {
            const reader = new FileReader();
            reader.onload = () => resolve(reader.result);
            reader.readAsDataURL(blob);
          });
          m.downloading = false;
          m.imageDataUrl = dataUrl;
          m.downloaded = true;
          container.innerHTML = render({ username, displayName, messages, streakCount });
          attachListeners();
          // Wait for image to render then scroll
          requestAnimationFrame(() => {
            requestAnimationFrame(() => scrollToBottom());
          });
        } catch (err) {
          console.error('Failed to download attachment:', err);
          m.downloading = false;
          m.attachmentPreview = '[Failed to load]';
          container.innerHTML = render({ username, displayName, messages, streakCount });
          attachListeners();
        }
      }
    }
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
    container.innerHTML = render({ username, displayName, messages, streakCount });
    scrollToBottom();
    attachListeners();

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
    console.log('[Upload] Step 4: File input change event fired');
    const file = input.files[0];
    console.log('[Upload] Step 5: Got file:', file ? `${file.name} (${file.size} bytes)` : 'NO FILE');
    if (!file) {
      console.log('[Upload] ABORT: No file selected');
      return;
    }

    try {
      console.log('[Upload] Step 6: Reading file as ArrayBuffer');
      const buffer = await file.arrayBuffer();
      const bytes = new Uint8Array(buffer);
      console.log('[Upload] Step 7: File read complete:', bytes.length, 'bytes');

      // Convert to data URL for immediate display
      const blob = new Blob([bytes], { type: file.type || 'image/jpeg' });
      const imageDataUrl = await new Promise(resolve => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.readAsDataURL(blob);
      });
      console.log('[Upload] Step 8: Data URL created');

      const timestamp = Date.now();
      const msgIndex = messages.length;

      // Optimistic UI - show actual image
      messages.push({
        attachment: true,
        imageDataUrl,
        fromMe: true,
        timestamp
      });
      container.innerHTML = render({ username, displayName, messages, streakCount });
      scrollToBottom();
      attachListeners();
      console.log('[Upload] Step 9: UI updated with optimistic image');

      // Send and get the contentReference back
      console.log('[Upload] Step 10: Calling sendAttachment to', username);
      const ref = await client.sendAttachment(username, bytes);
      console.log('[Upload] Step 11: sendAttachment returned:', ref?.attachmentId || 'NO REF');

      // Store to IndexedDB with contentReference for persistence
      if (ref && ref.attachmentId) {
        messages[msgIndex].contentReference = ref;
        await client.messageStore.addMessage(username, {
          messageId: `att_${ref.attachmentId}`,
          content: '',
          contentReference: ref,
          isSent: true,
          timestamp,
        });
        console.log('[Upload] Step 12: Persisted to IndexedDB');
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
      container.innerHTML = render({ username, displayName, messages, streakCount });
      scrollToBottom();
      attachListeners();
    }
  };

  // Incoming attachments - auto-download and display
  const handleAttachment = async (att) => {
    // att.from is serverUserId (UUID), need to check if it matches this friend
    const friend = client.friends.get(username);
    const isFromFriend = friend?.devices?.some(d => d.serverUserId === att.from);
    if (isFromFriend) {
      // Add message with loading state
      const msgIndex = messages.length;
      messages.push({
        attachment: att.contentReference,
        downloading: true,
        fromMe: false,
        timestamp: Date.now()
      });
      container.innerHTML = render({ username, displayName, messages, streakCount });
      scrollToBottom();
      attachListeners();

      // Auto-download and display
      try {
        const decrypted = await client.attachments.download(att.contentReference);
        // Convert to data URL for display
        const blob = new Blob([decrypted], { type: 'image/jpeg' });
        const dataUrl = await new Promise(resolve => {
          const reader = new FileReader();
          reader.onload = () => resolve(reader.result);
          reader.readAsDataURL(blob);
        });
        messages[msgIndex].downloading = false;
        messages[msgIndex].imageDataUrl = dataUrl;
        messages[msgIndex].downloaded = true;
        messages[msgIndex].contentReference = att.contentReference;
        container.innerHTML = render({ username, displayName, messages, streakCount });
        attachListeners();
        // Scroll after render
        scrollToBottom();
        // Wait for image to render and scroll again
        const images = container.querySelectorAll('.attachment-image');
        const lastImg = images[images.length - 1];
        if (lastImg) {
          if (lastImg.complete) {
            // Image already loaded (data URL), wait for next frame to ensure layout
            requestAnimationFrame(() => {
              requestAnimationFrame(() => scrollToBottom());
            });
          } else {
            // Image still loading
            lastImg.onload = () => scrollToBottom();
          }
        }

        // Store to IndexedDB for persistence
        await client.messageStore.addMessage(username, {
          messageId: `att_${att.contentReference?.attachmentId || Date.now()}`,
          content: '',
          contentReference: att.contentReference,
          isSent: false,
          timestamp: Date.now(),
        });
      } catch (err) {
        console.error('Failed to download attachment:', err);
        messages[msgIndex].downloading = false;
        messages[msgIndex].attachmentPreview = '[Failed to load]';
        container.innerHTML = render({ username, displayName, messages, streakCount });
        attachListeners();
      }
    }
  };

  // Sent sync - messages sent from another device
  const handleSentSync = (sync) => {
    if (sync.conversationId === username) {
      // Decode content if it's a Uint8Array
      let text = '';
      if (sync.content) {
        text = sync.content instanceof Uint8Array
          ? new TextDecoder().decode(sync.content)
          : String(sync.content);
      }

      messages.push({
        text,
        fromMe: true,
        timestamp: sync.timestamp || Date.now(),
        attachment: sync.contentReference,
        downloaded: false,
      });
      container.innerHTML = render({ username, displayName, messages, streakCount });
      scrollToBottom();
      attachListeners();
    }
  };

  client.on('message', handleMessage);
  client.on('attachment', handleAttachment);
  client.on('sentSync', handleSentSync);

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
          container.innerHTML = render({ username, displayName, messages, streakCount });
          attachListeners();
        } catch (err) {
          btn.textContent = 'Failed';
        }
      });
    });

    router.updatePageLinks();
  }

  attachListeners();
  scrollToBottom();

  // Start downloading any attachments that need loading
  downloadAttachments();

  cleanup = () => {
    client.off('message', handleMessage);
    client.off('attachment', handleAttachment);
    client.off('sentSync', handleSentSync);
  };
}

export function unmount() {
  if (cleanup) {
    cleanup();
    cleanup = null;
  }
}
