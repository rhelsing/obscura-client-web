/**
 * Logs View - displays all message send/receive events
 * Uses the centralized logger from v1
 */
import { navigate, clearClient } from '../index.js';
import { renderNav, initNav } from '../components/Nav.js';
import { ObscuraClient } from '../../lib/ObscuraClient.js';
import { logger } from '../../../lib/logger.js';
import { LogEventType } from '../../../lib/logStore.js';

// Re-export LogEventType for local use (imported from logStore)

// Color coding for event types
const EVENT_COLORS = {
  [LogEventType.SEND_START]: '#3b82f6',
  [LogEventType.SEND_ENCRYPT_START]: '#60a5fa',
  [LogEventType.SEND_ENCRYPT_COMPLETE]: '#60a5fa',
  [LogEventType.SEND_COMPLETE]: '#22c55e',
  [LogEventType.SEND_ERROR]: '#ef4444',
  [LogEventType.RECEIVE_ENVELOPE]: '#a855f7',
  [LogEventType.RECEIVE_DECRYPT_START]: '#c084fc',
  [LogEventType.RECEIVE_DECRYPT_COMPLETE]: '#c084fc',
  [LogEventType.RECEIVE_DECODE]: '#d8b4fe',
  [LogEventType.RECEIVE_COMPLETE]: '#22c55e',
  [LogEventType.RECEIVE_ERROR]: '#ef4444',
  [LogEventType.MESSAGE_LOST]: '#dc2626',
  [LogEventType.SESSION_ESTABLISH]: '#f97316',
  [LogEventType.SESSION_RESET]: '#fb923c',
  [LogEventType.GATEWAY_CONNECT]: '#6b7280',
  [LogEventType.GATEWAY_DISCONNECT]: '#9ca3af',
  [LogEventType.GATEWAY_ACK]: '#d1d5db',
};

const EVENT_DIRECTION = {
  [LogEventType.SEND_START]: 'out',
  [LogEventType.SEND_ENCRYPT_START]: 'out',
  [LogEventType.SEND_ENCRYPT_COMPLETE]: 'out',
  [LogEventType.SEND_COMPLETE]: 'out',
  [LogEventType.SEND_ERROR]: 'out',
  [LogEventType.RECEIVE_ENVELOPE]: 'in',
  [LogEventType.RECEIVE_DECRYPT_START]: 'in',
  [LogEventType.RECEIVE_DECRYPT_COMPLETE]: 'in',
  [LogEventType.RECEIVE_DECODE]: 'in',
  [LogEventType.RECEIVE_COMPLETE]: 'in',
  [LogEventType.RECEIVE_ERROR]: 'in',
  [LogEventType.MESSAGE_LOST]: 'error',
  [LogEventType.SESSION_ESTABLISH]: 'session',
  [LogEventType.SESSION_RESET]: 'session',
  [LogEventType.GATEWAY_CONNECT]: 'gateway',
  [LogEventType.GATEWAY_DISCONNECT]: 'gateway',
  [LogEventType.GATEWAY_ACK]: 'gateway',
};

let cleanup = null;

export function render({ events = [], filter = 'all', expandedEvent = null } = {}) {
  // Show all events regardless of filter (tabs are just visual indicators)
  const filteredEvents = events;

  return `
    <div class="view logs">
      <header>
        <h1>Logs</h1>
        <button variant="secondary" id="clear-btn"><ry-icon name="trash"></ry-icon> Clear</button>
      </header>

      <ry-tabs id="log-tabs">
        <ry-tab title="All" data-filter="all" ${filter === 'all' ? 'active' : ''}></ry-tab>
        <ry-tab title="Send" data-filter="send" ${filter === 'send' ? 'active' : ''}></ry-tab>
        <ry-tab title="Receive" data-filter="receive" ${filter === 'receive' ? 'active' : ''}></ry-tab>
        <ry-tab title="Session" data-filter="session" ${filter === 'session' ? 'active' : ''}></ry-tab>
        <ry-tab title="Gateway" data-filter="gateway" ${filter === 'gateway' ? 'active' : ''}></ry-tab>
      </ry-tabs>

      <cluster style="margin: var(--ry-space-2) 0">
        <badge variant="primary">${filteredEvents.length} events</badge>
        <span class="live-dot"></span>
      </cluster>

      <stack gap="xs" class="logs-list">
        ${filteredEvents.length === 0 ? `
          <div class="empty">
            <p>No events logged yet</p>
            <ry-alert type="info">Send or receive messages to see logs here</ry-alert>
          </div>
        ` : filteredEvents.map(event => renderEvent(event, expandedEvent)).join('')}
      </stack>

      ${renderNav('more')}
    </div>
  `;
}

function renderEvent(event, expandedEvent) {
  const color = EVENT_COLORS[event.eventType] || '#6b7280';
  const direction = EVENT_DIRECTION[event.eventType] || '';
  const isExpanded = expandedEvent === event.id;

  const dirIcon = direction === 'out' ? '↑' : direction === 'in' ? '↓' : direction === 'session' ? '⇄' : '↔';

  const time = new Date(event.timestamp);
  const timeStr = time.toLocaleTimeString('en-US', {
    hour12: false,
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }) + '.' + String(time.getMilliseconds()).padStart(3, '0');

  const typeStr = event.eventType.replace(/_/g, ' ').toLowerCase();

  return `
    <card class="log-event ${isExpanded ? 'expanded' : ''}" data-id="${event.id}">
      <cluster>
        <span class="log-dir ${direction}">${dirIcon}</span>
        <span style="font-family: monospace; color: var(--ry-color-text-muted); font-size: var(--ry-text-sm)">${timeStr}</span>
        <badge style="background: ${color}; color: white">${typeStr}</badge>
        <span style="font-family: monospace; color: var(--ry-color-text-muted); font-size: var(--ry-text-sm); margin-left: auto">${(event.correlationId || '').slice(-6)}</span>
        <ry-icon name="${isExpanded ? 'chevron-down' : 'chevron-right'}"></ry-icon>
      </cluster>
      ${isExpanded ? `
        <divider></divider>
        <pre style="font-family: monospace; font-size: 12px; white-space: pre-wrap; word-break: break-all; background: var(--ry-color-bg); padding: var(--ry-space-3); border-radius: var(--ry-radius-sm); max-height: 200px; overflow-y: auto">${JSON.stringify(event.data, null, 2)}</pre>
      ` : ''}
    </card>
  `;
}

export async function mount(container, client, router) {
  let events = [];
  let filter = 'all';
  let expandedEvent = null;
  let unsubscribe = null;

  // Load existing events from logger
  try {
    events = await logger.getAllEvents(200);
  } catch (err) {
    console.warn('[Logs] Failed to load events:', err);
  }

  // Subscribe to new events
  unsubscribe = logger.onLog((event) => {
    events.unshift(event);
    if (events.length > 200) events.pop();
    rerender();
  });

  function rerender() {
    container.innerHTML = render({ events, filter, expandedEvent });
    attachListeners();
  }

  function attachListeners() {
    // Filter via tabs - listen for ry:change on tabs component
    const tabs = container.querySelector('#log-tabs');
    tabs?.addEventListener('ry:change', (e) => {
      const activeTab = e.detail.tab;
      if (activeTab) {
        filter = activeTab.dataset.filter || 'all';
        rerender();
      }
    });

    // Clear
    container.querySelector('#clear-btn')?.addEventListener('click', async () => {
      try {
        await logger.clearAll();
        events = [];
        rerender();
      } catch (err) {
        console.warn('[Logs] Failed to clear:', err);
      }
    });

    // Expand/collapse
    container.querySelectorAll('.log-event').forEach(el => {
      el.addEventListener('click', () => {
        const id = parseFloat(el.dataset.id);
        expandedEvent = expandedEvent === id ? null : id;
        rerender();
      });
    });

    // Nav
    initNav(container, () => {
      client.disconnect();
      ObscuraClient.clearSession();
      clearClient();
      navigate('/login');
    });

    router.updatePageLinks();
  }

  rerender();

  cleanup = () => {
    // Unsubscribe from logger
    if (unsubscribe) {
      unsubscribe();
    }
  };
}

export function unmount() {
  if (cleanup) {
    cleanup();
    cleanup = null;
  }
}
