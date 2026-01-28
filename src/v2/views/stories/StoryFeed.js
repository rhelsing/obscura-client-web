/**
 * StoryFeed View
 * - List stories from friends (ephemeral, 24h)
 * - Batch load comments + reactions
 */
import { navigate } from '../index.js';

let cleanup = null;

export function render({ stories = [], loading = false } = {}) {
  return `
    <div class="view story-feed">
      <header>
        <h1>Feed</h1>
      </header>

      ${loading ? `
        <div class="loading">Loading stories...</div>
      ` : stories.length === 0 ? `
        <div class="empty">
          <p>No stories yet</p>
          <p class="hint">Stories disappear after 24 hours</p>
        </div>
      ` : `
        <div class="stories-list">
          ${stories.map(s => `
            <article class="story-card" data-id="${s.id}">
              <div class="story-header">
                <span class="author">${s.authorName || 'Unknown'}</span>
                <span class="time">${formatTimeAgo(s.timestamp)}</span>
              </div>
              <div class="story-content">${escapeHtml(s.data.content)}</div>
              ${s.data.mediaUrl ? `
                <div class="story-media">
                  <img src="${s.data.mediaUrl}" alt="" />
                </div>
              ` : ''}
              <div class="story-footer">
                <span class="reactions">${formatReactions(s.reactions || [])}</span>
                <span class="comments">${(s.comments || []).length} comments</span>
              </div>
            </article>
          `).join('')}
        </div>
      `}

      <a href="/stories/new" data-navigo class="fab">+</a>

      <nav class="bottom-nav">
        <a href="/stories" data-navigo class="active">Feed</a>
        <a href="/messages" data-navigo>Messages</a>
        <a href="/friends" data-navigo>Friends</a>
        <a href="/settings" data-navigo>Settings</a>
      </nav>
    </div>
  `;
}

function escapeHtml(text) {
  if (!text) return '';
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

function formatTimeAgo(ts) {
  if (!ts) return '';
  const diff = Date.now() - ts;
  const mins = Math.floor(diff / 60000);
  const hours = Math.floor(diff / 3600000);

  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  if (hours < 24) return `${hours}h ago`;
  return 'yesterday';
}

function formatReactions(reactions) {
  if (!reactions.length) return '';
  // Group by emoji
  const counts = {};
  reactions.forEach(r => {
    const emoji = r.data?.emoji || '❤️';
    counts[emoji] = (counts[emoji] || 0) + 1;
  });
  return Object.entries(counts)
    .map(([emoji, count]) => `${emoji} ${count}`)
    .join(' ');
}

export async function mount(container, client, router) {
  container.innerHTML = render({ loading: true });

  try {
    // Check if schema is defined
    if (!client.story) {
      container.innerHTML = `<div class="error">Story model not defined. Call client.schema() first.</div>`;
      return;
    }

    // Query stories
    const stories = await client.story.where({})
      .orderBy('timestamp', 'desc')
      .exec();

    // Batch load comments and reactions
    if (client.comment) {
      await client.comment.loadInto(stories, 'storyId');
    }
    if (client.reaction) {
      await client.reaction.loadInto(stories, 'storyId');
    }

    container.innerHTML = render({ stories });

    // Click handlers
    container.querySelectorAll('.story-card').forEach(card => {
      card.addEventListener('click', () => {
        navigate(`/stories/${card.dataset.id}`);
      });
    });

    router.updatePageLinks();

  } catch (err) {
    container.innerHTML = `<div class="error">Failed to load stories: ${err.message}</div>`;
  }

  // Listen for new stories
  const handleSync = async (sync) => {
    if (sync.model === 'story') {
      // Refresh feed
      mount(container, client, router);
    }
  };

  client.on('modelSync', handleSync);

  cleanup = () => {
    client.off('modelSync', handleSync);
  };
}

export function unmount() {
  if (cleanup) {
    cleanup();
    cleanup = null;
  }
}
