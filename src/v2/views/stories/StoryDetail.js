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
        <a href="/stories" data-navigo class="back"><ry-icon name="chevron-left"></ry-icon> Back</a>
      </header>

      <card>
        <cluster>
          <strong>${story.authorName || 'Unknown'}</strong>
          <span style="color: var(--ry-color-text-muted)">${formatTime(story.timestamp)}</span>
        </cluster>

        <p style="margin: var(--ry-space-3) 0">${escapeHtml(story.data.content)}</p>

        ${story.mediaBlobUrl ? `
          <div class="story-media">
            <img src="${story.mediaBlobUrl}" alt="" style="width: 100%; border-radius: var(--ry-radius-md)" />
          </div>
        ` : story.hasMedia ? `
          <div class="story-media">
            <button variant="secondary" size="sm" id="load-media-btn">
              <ry-icon name="download"></ry-icon> Load Media
            </button>
          </div>
        ` : ''}

        <divider></divider>

        <cluster>
          ${formatReactionGroups(reactions) || '<span style="color: var(--ry-color-text-muted)">No reactions</span>'}
        </cluster>

        <cluster class="reaction-picker">
          ${['❤️', '🔥', '😂', '😮', '😢', '👏'].map(emoji => `
            <button variant="ghost" size="sm" class="reaction-btn" data-emoji="${emoji}">${emoji}</button>
          `).join('')}
        </cluster>
      </card>

      <stack gap="md" class="comments-section" style="margin-top: var(--ry-space-4)">
        <h2>Comments (${comments.length})</h2>

        <stack gap="sm" class="comments-list">
          ${comments.length === 0 ? `
            <p style="color: var(--ry-color-text-muted)">No comments yet</p>
          ` : `
            ${renderComments(comments)}
          `}
        </stack>

        <form id="comment-form">
          <cluster>
            <input type="text" id="comment-text" placeholder="Add a comment..." autocomplete="off" style="flex: 1" />
            <button type="submit">Post</button>
          </cluster>
        </form>
      </stack>
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

/**
 * Resolve authorDeviceId to a username
 */
function resolveAuthorName(authorDeviceId, client) {
  if (authorDeviceId === client.deviceUUID) {
    return 'You';
  }

  if (client.friends && client.friends.friends) {
    for (const [username, data] of client.friends.friends) {
      if (data.devices) {
        for (const device of data.devices) {
          if (device.deviceUUID === authorDeviceId || device.serverUserId === authorDeviceId) {
            return username;
          }
        }
      }
    }
  }

  return authorDeviceId?.slice(0, 8) || 'Unknown';
}

/**
 * Parse mediaUrl - could be a direct URL or a JSON attachment reference
 */
function parseMediaUrl(mediaUrl) {
  if (!mediaUrl) return null;

  try {
    const parsed = JSON.parse(mediaUrl);
    if (parsed.attachmentId && parsed.contentKey) {
      return {
        isRef: true,
        ref: {
          attachmentId: parsed.attachmentId,
          contentKey: new Uint8Array(parsed.contentKey),
          nonce: new Uint8Array(parsed.nonce),
          contentType: parsed.contentType || 'application/octet-stream',
        },
      };
    }
  } catch {
    // Not JSON
  }

  if (mediaUrl.startsWith('http') || mediaUrl.startsWith('blob:') || mediaUrl.startsWith('data:')) {
    return { isRef: false, url: mediaUrl };
  }

  return null;
}

/**
 * Download and decrypt media attachment
 */
async function loadMedia(mediaUrl, client) {
  const parsed = parseMediaUrl(mediaUrl);
  if (!parsed) return null;

  if (!parsed.isRef) return parsed.url;

  try {
    const bytes = await client.attachments.download(parsed.ref);
    const blob = new Blob([bytes], { type: parsed.ref.contentType });
    return URL.createObjectURL(blob);
  } catch (err) {
    console.error('Failed to load media:', err);
    return null;
  }
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
    <card style="margin-left: ${depth * 20}px">
      <cluster>
        <strong>${c.authorName || 'Unknown'}</strong>
        <span style="color: var(--ry-color-text-muted); font-size: var(--ry-text-sm)">${formatTime(c.timestamp)}</span>
      </cluster>
      <p style="margin: var(--ry-space-2) 0">${escapeHtml(c.data?.text)}</p>
      <button variant="ghost" size="sm" class="reply-btn" data-comment-id="${c.id}">Reply</button>
      ${c.replies ? renderComments(c.replies, depth + 1) : ''}
    </card>
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
      // Resolve comment author names
      story.comments = comments.map(c => ({
        ...c,
        authorName: resolveAuthorName(c.authorDeviceId, client),
      }));
    }

    if (client.reaction) {
      const reactions = await client.reaction.where({
        'data.storyId': storyId
      }).exec();
      story.reactions = reactions;
    }

    // Resolve story author name and check for media
    story.authorName = resolveAuthorName(story.authorDeviceId, client);
    story.hasMedia = !!parseMediaUrl(story.data?.mediaUrl);
    story.mediaBlobUrl = null;

    const rerender = () => {
      container.innerHTML = render({ story });
      attachEventHandlers();
    };

    const attachEventHandlers = () => {
      // Load media button
      const loadMediaBtn = container.querySelector('#load-media-btn');
      if (loadMediaBtn) {
        loadMediaBtn.addEventListener('click', async () => {
          loadMediaBtn.textContent = 'Loading...';
          loadMediaBtn.disabled = true;
          story.mediaBlobUrl = await loadMedia(story.data?.mediaUrl, client);
          rerender();
        });
      }

      // Comment form
      const commentForm = container.querySelector('#comment-form');
      if (commentForm) {
        commentForm.addEventListener('submit', async (e) => {
          e.preventDefault();
          const text = container.querySelector('#comment-text').value.trim();
          if (!text) return;

          try {
            await client.comment.create({ storyId, text });
            mount(container, client, router, params);
          } catch (err) {
            alert('Failed to post comment: ' + err.message);
          }
        });
      }

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
    };

    container.innerHTML = render({ story });
    attachEventHandlers();

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
