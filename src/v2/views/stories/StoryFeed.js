/**
 * StoryFeed View
 * - List stories from friends (ephemeral, 24h)
 * - Batch load comments + reactions
 */
import { navigate, clearClient, getBadgeCounts } from '../index.js';
import { renderNav, initNav } from '../components/Nav.js';
import { ObscuraClient } from '../../lib/ObscuraClient.js';

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
          <ry-alert type="info">Stories disappear after 24 hours</ry-alert>
        </div>
      ` : `
        <stack gap="md" class="stories-list">
          ${stories.map(s => `
            <card class="story-card" data-id="${s.id}">
              <cluster>
                <strong style="color: var(--text)">${s.authorName || 'Unknown'}</strong>
                <span style="color: var(--text-secondary)">${formatTimeAgo(s.timestamp)}</span>
              </cluster>
              <p style="margin: var(--ry-space-3) 0; color: var(--text)">${escapeHtml(s.data.content)}</p>
              ${s.mediaBlobUrl ? `
                <div class="story-media">
                  <img src="${s.mediaBlobUrl}" alt="" style="width: 100%; border-radius: var(--ry-radius-md)" />
                </div>
              ` : s.hasMedia && !s.mediaLoading ? `
                <div class="story-media">
                  <button variant="secondary" size="sm" class="load-media-btn" data-story-id="${s.id}">
                    <ry-icon name="download"></ry-icon> Load Media
                  </button>
                </div>
              ` : s.mediaLoading ? `
                <div class="story-media">
                  <span style="color: var(--text-secondary)">Loading media...</span>
                </div>
              ` : ''}
              <actions>
                <button variant="ghost" size="sm" class="story-action-btn" data-story-id="${s.id}">${formatReactions(s.reactions || []) || '❤️ 0'}</button>
                <button variant="ghost" size="sm" class="story-action-btn" data-story-id="${s.id}">💬 ${(s.comments || []).length}</button>
              </actions>
            </card>
          `).join('')}
        </stack>
      `}

      <a href="/stories/new" data-navigo class="fab">+</a>

      ${renderNav('stories', getBadgeCounts())}
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

/**
 * Parse mediaUrl - could be a direct URL or a JSON attachment reference
 * @param {string} mediaUrl - The stored mediaUrl value
 * @returns {object|null} - { isRef: true, ref: {...} } or { isRef: false, url: '...' } or null
 */
function parseMediaUrl(mediaUrl) {
  if (!mediaUrl) return null;

  // Try to parse as JSON (new encrypted attachment format)
  try {
    const parsed = JSON.parse(mediaUrl);
    if (parsed.attachmentId && parsed.contentKey) {
      return {
        isRef: true,
        ref: {
          attachmentId: parsed.attachmentId,
          contentKey: new Uint8Array(parsed.contentKey),
          nonce: new Uint8Array(parsed.nonce),
          contentHash: parsed.contentHash ? new Uint8Array(parsed.contentHash) : undefined,
          contentType: parsed.contentType || 'application/octet-stream',
        },
      };
    }
  } catch {
    // Not JSON, treat as direct URL
  }

  // Direct URL (legacy or external)
  if (mediaUrl.startsWith('http') || mediaUrl.startsWith('blob:') || mediaUrl.startsWith('data:')) {
    return { isRef: false, url: mediaUrl };
  }

  return null;
}

/**
 * Download and decrypt a media attachment, return blob URL
 */
async function loadMediaForStory(story, client) {
  const parsed = parseMediaUrl(story.data?.mediaUrl);
  if (!parsed) return null;

  if (!parsed.isRef) {
    // Direct URL, use as-is
    return parsed.url;
  }

  // Download and decrypt
  try {
    const bytes = await client.attachments.download(parsed.ref);
    const blob = new Blob([bytes], { type: parsed.ref.contentType });
    return URL.createObjectURL(blob);
  } catch (err) {
    console.error('Failed to load media:', err);
    return null;
  }
}

/**
 * Resolve authorDeviceId to a username
 * @param {object} story - Story object with authorDeviceId and optional data.authorUsername
 * @param {object} client - ObscuraClient instance
 * @returns {string} - Username or truncated ID
 */
function resolveAuthorName(story, client, profileMap = new Map()) {
  const authorDeviceId = story.authorDeviceId;

  // Check if it's our own story
  if (authorDeviceId === client.deviceUUID) {
    return 'You';
  }

  // Check profile displayName first (from pre-loaded profiles)
  if (profileMap.has(authorDeviceId)) {
    return profileMap.get(authorDeviceId);
  }

  // First check if authorUsername is stored
  if (story.data?.authorUsername) {
    return story.data.authorUsername;
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

export async function mount(container, client, router) {
  container.innerHTML = render({ loading: true });

  try {
    // Check if schema is defined
    if (!client.story) {
      container.innerHTML = `<div class="error">Story model not defined. Call client.schema() first.</div>`;
      return;
    }

    // Get all known usernames (own username + friend usernames)
    const knownUsernames = new Set([client.username]);

    // Add all friend usernames
    if (client.friends && client.friends.friends) {
      for (const [username] of client.friends.friends) {
        knownUsernames.add(username);
      }
    }

    // Query all stories then filter to known usernames and non-expired (24h TTL)
    const allStories = await client.story.where({})
      .orderBy('timestamp', 'desc')
      .exec();

    const now = Date.now();
    const ttl24h = 24 * 60 * 60 * 1000;
    const stories = allStories
      .filter(s => knownUsernames.has(s.data?.authorUsername))
      .filter(s => (now - s.timestamp) < ttl24h);

    // Batch load comments and reactions
    if (client.comment) {
      await client.comment.loadInto(stories, 'storyId');
    }
    if (client.reaction) {
      await client.reaction.loadInto(stories, 'storyId');
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

    // Resolve author names and check for media
    // NOTE: Don't use sessionStorage for blob URLs - they become invalid after page refresh
    // The attachmentStore caches actual bytes, so download() will be a cache hit
    const storiesWithNames = stories.map(s => ({
      ...s,
      authorName: resolveAuthorName(s, client, profileMap),
      hasMedia: !!parseMediaUrl(s.data?.mediaUrl),
      mediaBlobUrl: null,
      mediaLoading: false,
    }));

    // Store stories for later reference (for loading media)
    let displayStories = storiesWithNames;

    const rerender = () => {
      container.innerHTML = render({ stories: displayStories });
      attachEventHandlers();
    };

    // Auto-download media for stories that need it
    const storiesNeedingMedia = displayStories.filter(s => s.hasMedia && !s.mediaBlobUrl);
    if (storiesNeedingMedia.length > 0) {
      // Mark as loading
      storiesNeedingMedia.forEach(s => s.mediaLoading = true);
    }

    const attachEventHandlers = () => {
      // Click handlers for story cards
      container.querySelectorAll('.story-card').forEach(card => {
        card.addEventListener('click', (e) => {
          // Don't navigate if clicking a button
          if (e.target.closest('.load-media-btn') || e.target.closest('button')) return;
          navigate(`/stories/${card.dataset.id}`);
        });
      });

      // Reaction/comment button handlers - navigate to story detail
      container.querySelectorAll('.story-action-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          navigate(`/stories/${btn.dataset.storyId}`);
        });
      });

      // Load media buttons
      container.querySelectorAll('.load-media-btn').forEach(btn => {
        btn.addEventListener('click', async (e) => {
          e.stopPropagation();
          const storyId = btn.dataset.storyId;
          const story = displayStories.find(s => s.id === storyId);
          if (!story) return;

          // Mark as loading
          story.mediaLoading = true;
          rerender();

          // Download and decrypt
          const blobUrl = await loadMediaForStory(story, client);
          story.mediaLoading = false;
          story.mediaBlobUrl = blobUrl;
          rerender();
        });
      });

      // Init nav
      initNav(container, () => {
        client.disconnect();
        ObscuraClient.clearSession();
        clearClient();
        navigate('/login');
      });

      router.updatePageLinks();
    };

    container.innerHTML = render({ stories: displayStories });
    attachEventHandlers();

    // Auto-download media in background after initial render
    if (storiesNeedingMedia.length > 0) {
      // Download all in parallel
      await Promise.all(storiesNeedingMedia.map(async (s) => {
        const blobUrl = await loadMediaForStory(s, client);
        s.mediaLoading = false;
        s.mediaBlobUrl = blobUrl;
      }));
      // Re-render with loaded media
      rerender();
    }

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
