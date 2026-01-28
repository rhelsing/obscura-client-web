/**
 * CreateStory View
 * - Text input for content
 * - Optional media upload
 */
import { navigate } from '../index.js';

let cleanup = null;

export function render({ error = null, loading = false } = {}) {
  return `
    <div class="view create-story">
      <header>
        <a href="/stories" data-navigo class="back">← Cancel</a>
        <h1>New Story</h1>
      </header>

      ${error ? `<div class="error">${error}</div>` : ''}

      <form id="story-form">
        <textarea
          id="content"
          placeholder="What's on your mind?"
          rows="5"
          required
          ${loading ? 'disabled' : ''}
        ></textarea>

        <div class="media-section">
          <button type="button" id="add-media-btn" class="secondary" ${loading ? 'disabled' : ''}>
            Add Photo/Video
          </button>
          <div id="media-preview" class="hidden"></div>
        </div>

        <button type="submit" class="primary" ${loading ? 'disabled' : ''}>
          ${loading ? 'Posting...' : 'Post Story'}
        </button>
      </form>

      <input type="file" id="media-input" accept="image/*,video/*" hidden />

      <p class="hint">Stories disappear after 24 hours</p>
    </div>
  `;
}

export function mount(container, client, router) {
  container.innerHTML = render();

  const form = container.querySelector('#story-form');
  const mediaBtn = container.querySelector('#add-media-btn');
  const mediaInput = container.querySelector('#media-input');
  const mediaPreview = container.querySelector('#media-preview');

  let mediaUrl = null;

  // Media picker
  mediaBtn.addEventListener('click', () => {
    mediaInput.click();
  });

  mediaInput.addEventListener('change', () => {
    const file = mediaInput.files[0];
    if (file) {
      // For now, just show filename (real impl would upload)
      mediaPreview.textContent = file.name;
      mediaPreview.classList.remove('hidden');
      // TODO: Upload and get URL
      mediaUrl = null; // Placeholder
    }
  });

  // Submit
  const handleSubmit = async (e) => {
    e.preventDefault();

    const content = container.querySelector('#content').value.trim();

    if (!content) {
      container.innerHTML = render({ error: 'Please enter some content' });
      mount(container, client, router);
      return;
    }

    container.innerHTML = render({ loading: true });

    try {
      if (!client.story) {
        throw new Error('Story model not defined. Call client.schema() first.');
      }

      await client.story.create({
        content,
        mediaUrl: mediaUrl || undefined
      });

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
  };
}

export function unmount() {
  if (cleanup) {
    cleanup();
    cleanup = null;
  }
}
