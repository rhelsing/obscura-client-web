/**
 * CreateStory View
 * - Text input for content
 * - Optional media upload (uploaded via attachments API)
 */
import { navigate } from '../index.js';

let cleanup = null;
let pendingMedia = null; // { file, bytes }

export function render({ error = null, loading = false, mediaName = null } = {}) {
  return `
    <div class="view create-story">
      <header>
        <a href="/stories" data-navigo class="back"><ry-icon name="chevron-left"></ry-icon> Cancel</a>
        <h1>New Story</h1>
      </header>

      ${error ? `<ry-alert type="danger">${error}</ry-alert>` : ''}

      <form id="story-form">
        <stack gap="md">
          <ry-field label="What's on your mind?">
            <textarea
              id="content"
              placeholder="Share something..."
              rows="5"
              ${loading ? 'disabled' : ''}
            ></textarea>
          </ry-field>

          <cluster>
            <button type="button" variant="secondary" id="add-media-btn" ${loading ? 'disabled' : ''}>
              <ry-icon name="upload"></ry-icon> Add Photo/Video
            </button>
            <span id="media-preview" class="hidden"></span>
          </cluster>

          <button type="submit" ${loading ? 'disabled' : ''}>
            ${loading ? 'Posting...' : 'Post Story'}
          </button>
        </stack>
      </form>

      <input type="file" id="media-input" accept="image/*,video/*" hidden />

      <ry-alert type="info" style="margin-top: var(--ry-space-4)">Stories disappear after 24 hours</ry-alert>
    </div>
  `;
}

export function mount(container, client, router) {
  pendingMedia = null;
  container.innerHTML = render();

  const form = container.querySelector('#story-form');
  const mediaBtn = container.querySelector('#add-media-btn');
  const mediaInput = container.querySelector('#media-input');
  const mediaPreview = container.querySelector('#media-preview');

  // Media picker
  mediaBtn.addEventListener('click', () => {
    mediaInput.click();
  });

  mediaInput.addEventListener('change', async () => {
    const file = mediaInput.files[0];
    if (file) {
      // Read file bytes for later upload
      const buffer = await file.arrayBuffer();
      pendingMedia = {
        file,
        bytes: new Uint8Array(buffer),
        contentType: file.type,
      };
      mediaPreview.textContent = `📎 ${file.name}`;
      mediaPreview.classList.remove('hidden');
    }
  });

  // Submit
  const handleSubmit = async (e) => {
    e.preventDefault();

    const content = container.querySelector('#content').value.trim();

    if (!content && !pendingMedia) {
      container.innerHTML = render({ error: 'Please enter content or add media' });
      mount(container, client, router);
      return;
    }

    container.innerHTML = render({ loading: true });

    try {
      if (!client.story) {
        throw new Error('Story model not defined. Call client.schema() first.');
      }

      let mediaUrl = undefined;

      // Upload media if present
      if (pendingMedia) {
        // Upload using attachments API (encrypts and uploads)
        const ref = await client.attachments.upload(pendingMedia.bytes);
        // Store the attachment reference as a JSON string in mediaUrl
        // This allows the story to reference the encrypted attachment
        mediaUrl = JSON.stringify({
          attachmentId: ref.attachmentId,
          contentKey: Array.from(ref.contentKey),
          nonce: Array.from(ref.nonce),
          contentHash: Array.from(ref.contentHash),
          contentType: pendingMedia.contentType,
        });
      }

      const story = await client.story.create({
        content,
        mediaUrl,
        authorUsername: client.username,
      });

      // Cache the blob URL for immediate display after redirect
      if (pendingMedia && story.id) {
        const blob = new Blob([pendingMedia.bytes], { type: pendingMedia.contentType });
        const blobUrl = URL.createObjectURL(blob);
        sessionStorage.setItem(`story_media_${story.id}`, blobUrl);
      }

      navigate('/stories');

    } catch (err) {
      container.innerHTML = render({ error: err.message });
      mount(container, client, router);
    }
  };

  form.addEventListener('submit', handleSubmit);
  router.updatePageLinks();

  cleanup = () => {
    form.removeEventListener('submit', handleSubmit);
    pendingMedia = null;
  };
}

export function unmount() {
  if (cleanup) {
    cleanup();
    cleanup = null;
  }
}
