/**
 * Chat View
 * - Message list for a conversation
 * - Send text + attachments
 * - Real-time incoming messages
 */
import { navigate } from '../index.js';

let cleanup = null;
let messages = [];

export function render({ username = '', messages = [], sending = false } = {}) {
  return `
    <div class="view chat">
      <header>
        <a href="/messages" data-navigo class="back">← Back</a>
        <h1>${username}</h1>
        <a href="/profile/${username}" data-navigo class="profile-link">Profile</a>
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
                  ${m.downloaded ? `
                    <div class="attachment-content">${m.attachmentPreview || '[Attachment]'}</div>
                  ` : `
                    <button class="download-btn" data-ref="${m.attachment}">Download</button>
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
        <button type="button" id="attach-btn" class="attach-button" ${sending ? 'disabled' : ''}>📎</button>
        <input
          type="text"
          id="message-text"
          placeholder="Type a message..."
          autocomplete="off"
          ${sending ? 'disabled' : ''}
        />
        <button type="submit" ${sending ? 'disabled' : ''}>${sending ? '...' : 'Send'}</button>
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

export function mount(container, client, router, params) {
  const username = params.username;
  messages = []; // TODO: Load from local store

  container.innerHTML = render({ username, messages });

  const form = container.querySelector('#message-form');
  const input = container.querySelector('#message-text');
  const attachBtn = container.querySelector('#attach-btn');
  const fileInput = container.querySelector('#file-input');
  const messagesContainer = container.querySelector('#messages');

  // Scroll to bottom
  const scrollToBottom = () => {
    messagesContainer.scrollTop = messagesContainer.scrollHeight;
  };

  // Send message
  const handleSubmit = async (e) => {
    e.preventDefault();

    const text = input.value.trim();
    if (!text) return;

    input.value = '';

    // Optimistic UI update
    messages.push({
      text,
      fromMe: true,
      timestamp: Date.now()
    });
    container.innerHTML = render({ username, messages });
    scrollToBottom();

    try {
      await client.send(username, { text });
    } catch (err) {
      console.error('Failed to send:', err);
      // Could mark message as failed
    }
  };

  form.addEventListener('submit', handleSubmit);

  // Attachment button
  attachBtn.addEventListener('click', () => {
    fileInput.click();
  });

  // File selected
  fileInput.addEventListener('change', async () => {
    const file = fileInput.files[0];
    if (!file) return;

    try {
      const buffer = await file.arrayBuffer();
      const bytes = new Uint8Array(buffer);

      // Optimistic UI
      messages.push({
        attachment: 'pending',
        attachmentPreview: `[${file.name}]`,
        downloaded: true,
        fromMe: true,
        timestamp: Date.now()
      });
      container.innerHTML = render({ username, messages });
      scrollToBottom();

      await client.sendAttachment(username, bytes);

    } catch (err) {
      console.error('Failed to send attachment:', err);
    }

    fileInput.value = '';
  });

  // Incoming messages
  const handleMessage = (msg) => {
    if (msg.from === username || msg.conversationId === username) {
      messages.push({
        text: msg.text,
        fromMe: false,
        timestamp: msg.timestamp || Date.now()
      });
      container.innerHTML = render({ username, messages });
      scrollToBottom();
      attachListeners();
    }
  };

  // Incoming attachments
  const handleAttachment = (att) => {
    if (att.from === username) {
      messages.push({
        attachment: att.contentReference,
        downloaded: false,
        fromMe: false,
        timestamp: Date.now()
      });
      container.innerHTML = render({ username, messages });
      scrollToBottom();
      attachListeners();
    }
  };

  client.on('message', handleMessage);
  client.on('attachment', handleAttachment);

  function attachListeners() {
    // Re-attach form listener after re-render
    const newForm = container.querySelector('#message-form');
    newForm.addEventListener('submit', handleSubmit);

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
          container.innerHTML = render({ username, messages });
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

  cleanup = () => {
    client.off('message', handleMessage);
    client.off('attachment', handleAttachment);
  };
}

export function unmount() {
  if (cleanup) {
    cleanup();
    cleanup = null;
  }
}
