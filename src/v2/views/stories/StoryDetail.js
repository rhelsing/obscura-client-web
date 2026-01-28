/**
 * StoryDetail View
 * - Full story with comments and reactions
 * - Add comment / reaction
 */
import { navigate } from '../index.js';

let cleanup = null;

export function render({ story = null, loading = false, error = null } = {}) {
  if (loading) {
    return `<div class="view story-detail"><div class="loading">Loading...</div></div>`;
  }

  if (error) {
    return `<div class="view story-detail"><div class="error">${error}</div></div>`;
  }

  if (!story) {
    return `<div class="view story-detail"><div class="error">Story not found</div></div>`;
  }

  const comments = story.comments || [];
  const reactions = story.reactions || [];

  return `
    <div class="view story-detail">
      <header>
        <a href="/stories" data-navigo class="back">← Back</a>
      </header>

      <article class="story-full">
        <div class="story-header">
          <span class="author">${story.authorName || 'Unknown'}</span>
          <span class="time">${formatTime(story.timestamp)}</span>
        </div>

        <div class="story-content">${escapeHtml(story.data.content)}</div>

        ${story.data.mediaUrl ? `
          <div class="story-media">
            <img src="${story.data.mediaUrl}" alt="" />
          </div>
        ` : ''}

        <div class="reactions-section">
          <div class="reactions-list">
            ${formatReactionGroups(reactions)}
          </div>
          <div class="reaction-picker">
            ${['❤️', '🔥', '😂', '😮', '😢', '👏'].map(emoji => `
              <button class="reaction-btn" data-emoji="${emoji}">${emoji}</button>
            `).join('')}
          </div>
        </div>
      </article>

      <section class="comments-section">
        <h2>Comments (${comments.length})</h2>

        <div class="comments-list">
          ${comments.length === 0 ? `
            <p class="empty">No comments yet</p>
          ` : `
            ${renderComments(comments)}
          `}
        </div>

        <form id="comment-form" class="comment-input">
          <input type="text" id="comment-text" placeholder="Add a comment..." autocomplete="off" />
          <button type="submit">Post</button>
        </form>
      </section>
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
  return new Date(ts).toLocaleString();
}

function formatReactionGroups(reactions) {
  const counts = {};
  reactions.forEach(r => {
    if (r.data?._deleted) return;
    const emoji = r.data?.emoji || '❤️';
    counts[emoji] = (counts[emoji] || 0) + 1;
  });

  return Object.entries(counts)
    .map(([emoji, count]) => `<span class="reaction-group">${emoji} ${count}</span>`)
    .join('');
}

function renderComments(comments, depth = 0) {
  // Filter out replies (they have commentId)
  const topLevel = depth === 0
    ? comments.filter(c => !c.data?.commentId)
    : comments;

  return topLevel.map(c => `
    <div class="comment" style="margin-left: ${depth * 20}px">
      <div class="comment-header">
        <span class="author">${c.authorName || 'Unknown'}</span>
        <span class="time">${formatTime(c.timestamp)}</span>
      </div>
      <div class="comment-text">${escapeHtml(c.data?.text)}</div>
      <button class="reply-btn" data-comment-id="${c.id}">Reply</button>
      ${c.replies ? renderComments(c.replies, depth + 1) : ''}
    </div>
  `).join('');
}

export async function mount(container, client, router, params) {
  const storyId = params.id;

  container.innerHTML = render({ loading: true });

  try {
    if (!client.story) {
      throw new Error('Story model not defined');
    }

    const story = await client.story.find(storyId);

    if (!story) {
      container.innerHTML = render({ error: 'Story not found' });
      return;
    }

    // Load comments and reactions
    if (client.comment) {
      const comments = await client.comment.where({
        'data.storyId': storyId
      }).exec();
      story.comments = comments;
    }

    if (client.reaction) {
      const reactions = await client.reaction.where({
        'data.storyId': storyId
      }).exec();
      story.reactions = reactions;
    }

    container.innerHTML = render({ story });

    // Comment form
    const commentForm = container.querySelector('#comment-form');
    commentForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const text = container.querySelector('#comment-text').value.trim();
      if (!text) return;

      try {
        await client.comment.create({ storyId, text });
        // Refresh
        mount(container, client, router, params);
      } catch (err) {
        alert('Failed to post comment: ' + err.message);
      }
    });

    // Reaction buttons
    container.querySelectorAll('.reaction-btn').forEach(btn => {
      btn.addEventListener('click', async () => {
        const emoji = btn.dataset.emoji;
        try {
          await client.reaction.create({ storyId, emoji });
          mount(container, client, router, params);
        } catch (err) {
          console.error('Failed to add reaction:', err);
        }
      });
    });

    // Reply buttons
    container.querySelectorAll('.reply-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const commentId = btn.dataset.commentId;
        const text = prompt('Enter reply:');
        if (text) {
          client.comment.create({ commentId, text }).then(() => {
            mount(container, client, router, params);
          });
        }
      });
    });

    router.updatePageLinks();

  } catch (err) {
    container.innerHTML = render({ error: err.message });
  }

  cleanup = () => {};
}

export function unmount() {
  if (cleanup) {
    cleanup();
    cleanup = null;
  }
}
