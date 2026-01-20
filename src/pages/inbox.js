// Inbox page - friends list and pending messages
import { friendStore, FriendStatus } from '../lib/friendStore.js';
import { showMessageViewer } from '../components/messageViewer.js';
import client from '../api/client.js';
import gateway from '../api/gateway.js';
import { sessionManager } from '../lib/sessionManager.js';

export function renderInbox(container, { friends: initialFriends, pendingMessages: initialMessages, refreshFriends, refreshMessages }) {
  let friends = initialFriends;
  let pendingMessages = initialMessages;

  async function render() {
    // Re-fetch fresh data from IndexedDB for real-time updates
    friends = await friendStore.getAllFriends();
    pendingMessages = await friendStore.getPendingMessages();

    const pendingRequests = friends.filter(f => f.status === FriendStatus.PENDING_RECEIVED);
    const acceptedFriends = friends.filter(f => f.status === FriendStatus.ACCEPTED);

    // Group pending messages by sender
    const messagesBySender = {};
    for (const msg of pendingMessages) {
      if (!messagesBySender[msg.fromUserId]) {
        messagesBySender[msg.fromUserId] = [];
      }
      messagesBySender[msg.fromUserId].push(msg);
    }

    container.innerHTML = `
      <div class="inbox-view">
        ${pendingRequests.length > 0 ? `
          <div class="inbox-section">
            <div class="inbox-section-title">Friend Requests</div>
            ${pendingRequests.map(req => `
              <div class="friend-request-card" data-userid="${req.userId}">
                <div class="friend-request-info">
                  <div class="friend-avatar">${req.username.charAt(0).toUpperCase()}</div>
                  <div class="friend-request-text">
                    <strong>${req.username}</strong> wants to be friends
                  </div>
                </div>
                <div class="friend-request-actions">
                  <button class="request-btn accept" data-action="accept" data-userid="${req.userId}">Accept</button>
                  <button class="request-btn decline" data-action="decline" data-userid="${req.userId}">Decline</button>
                </div>
              </div>
            `).join('')}
          </div>
        ` : ''}

        <div class="inbox-section">
          <div class="inbox-section-title">Friends</div>
          ${acceptedFriends.length === 0 ? `
            <div class="empty-state">
              <div class="empty-state-icon">👋</div>
              <div class="empty-state-text">No friends yet. Go to Camera and scan a QR code to add friends!</div>
            </div>
          ` : acceptedFriends.map(friend => {
            const hasUnread = messagesBySender[friend.userId]?.length > 0;
            return `
              <div class="friend-item" data-userid="${friend.userId}">
                <div class="message-indicator ${hasUnread ? 'unread' : 'empty'}"></div>
                <div class="friend-info">
                  <div class="friend-username">${friend.username}</div>
                  ${hasUnread ? `<div class="friend-status">New message</div>` : ''}
                </div>
              </div>
            `;
          }).join('')}
        </div>
      </div>
    `;

    attachListeners();
  }

  function attachListeners() {
    // Friend request actions
    container.querySelectorAll('.request-btn').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        const action = e.target.dataset.action;
        const userId = e.target.dataset.userid;

        if (action === 'accept') {
          await acceptFriendRequest(userId);
        } else {
          await declineFriendRequest(userId);
        }
      });
    });

    // Click on friend to view message
    container.querySelectorAll('.friend-item').forEach(item => {
      item.addEventListener('click', () => {
        const userId = item.dataset.userid;
        viewMessagesFrom(userId);
      });
    });
  }

  async function acceptFriendRequest(userId) {
    try {
      // Update local status
      await friendStore.updateFriendStatus(userId, FriendStatus.ACCEPTED);

      // Send acceptance message
      await gateway.loadProto();

      const username = localStorage.getItem('obscura_username') || 'Unknown';

      const clientMessageBytes = gateway.encodeClientMessage({
        type: 'FRIEND_RESPONSE',
        text: '',
        username: username,
        accepted: true,
      });

      const encrypted = await sessionManager.encrypt(userId, clientMessageBytes);
      const protobufData = gateway.encodeOutgoingMessage(encrypted.body, encrypted.protoType);

      await client.sendMessage(userId, protobufData);

      refreshFriends();
    } catch (err) {
      console.error('Failed to accept friend request:', err);
      alert('Failed to accept: ' + err.message);
    }
  }

  async function declineFriendRequest(userId) {
    try {
      await friendStore.removeFriend(userId);
      refreshFriends();
    } catch (err) {
      console.error('Failed to decline friend request:', err);
    }
  }

  async function viewMessagesFrom(userId) {
    const messages = await friendStore.getPendingMessagesFrom(userId);
    if (messages.length === 0) return;

    // Get friend info for display
    const friend = friends.find(f => f.userId === userId);

    // View messages one by one
    for (const message of messages) {
      await new Promise(resolve => {
        showMessageViewer(document.body, {
          ...message,
          senderUsername: friend?.username,
        }, async () => {
          // Delete message after viewing
          await friendStore.deletePendingMessage(message.id);
          resolve();
        });
      });
    }

    // Refresh to update indicators - need to await and re-fetch
    await refreshMessages();
    // Fetch fresh message list directly from store
    const freshMessages = await friendStore.getPendingMessages();
    pendingMessages = freshMessages;
    render();
  }

  // Initial render
  render();

  return { render };
}
