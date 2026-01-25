// Logs page - displays all message send/receive events
import { logger } from '../lib/logger.js';
import { LogEventType } from '../lib/logStore.js';

// Color coding for event types
const EVENT_COLORS = {
  // Send flow - blue
  [LogEventType.SEND_START]: '#3b82f6',
  [LogEventType.SEND_ENCRYPT_START]: '#60a5fa',
  [LogEventType.SEND_ENCRYPT_COMPLETE]: '#60a5fa',
  [LogEventType.SEND_COMPLETE]: '#22c55e',
  [LogEventType.SEND_ERROR]: '#ef4444',

  // Receive flow - purple
  [LogEventType.RECEIVE_ENVELOPE]: '#a855f7',
  [LogEventType.RECEIVE_DECRYPT_START]: '#c084fc',
  [LogEventType.RECEIVE_DECRYPT_COMPLETE]: '#c084fc',
  [LogEventType.RECEIVE_DECODE]: '#d8b4fe',
  [LogEventType.RECEIVE_COMPLETE]: '#22c55e',
  [LogEventType.RECEIVE_ERROR]: '#ef4444',

  // Critical errors - bright red
  [LogEventType.MESSAGE_LOST]: '#dc2626',

  // Session events - orange
  [LogEventType.SESSION_ESTABLISH]: '#f97316',
  [LogEventType.SESSION_RESET]: '#fb923c',

  // Gateway events - gray
  [LogEventType.GATEWAY_CONNECT]: '#6b7280',
  [LogEventType.GATEWAY_DISCONNECT]: '#9ca3af',
  [LogEventType.GATEWAY_ACK]: '#d1d5db',
};

// Direction indicators
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

export function renderLogs(container) {
  let events = [];
  let filter = 'all'; // 'all', 'send', 'receive', 'session', 'gateway'
  let expandedEvent = null;
  let unsubscribe = null;
  let isVisible = true;

  async function loadEvents() {
    try {
      events = await logger.getAllEvents(200);
    } catch (err) {
      console.error('Failed to load events:', err);
      events = [];
    }
  }

  // Subscribe to new log events for real-time updates
  function subscribe() {
    unsubscribe = logger.onLog((event) => {
      // Prepend new event (newest first)
      events.unshift(event);
      // Keep max 200
      if (events.length > 200) events.pop();
      // Only render when tab is visible
      if (isVisible) render();
    });
  }

  function getFilteredEvents() {
    if (filter === 'all') return events;

    return events.filter(event => {
      const direction = EVENT_DIRECTION[event.eventType];
      if (filter === 'send') return direction === 'out';
      if (filter === 'receive') return direction === 'in';
      if (filter === 'session') return direction === 'session';
      if (filter === 'gateway') return direction === 'gateway';
      return true;
    });
  }

  function formatTimestamp(ts) {
    const date = new Date(ts);
    return date.toLocaleTimeString('en-US', {
      hour12: false,
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    }) + '.' + String(date.getMilliseconds()).padStart(3, '0');
  }

  function formatEventType(type) {
    return type.replace(/_/g, ' ').toLowerCase();
  }

  function formatData(data, indent = 0) {
    if (data === null || data === undefined) return 'null';
    if (typeof data !== 'object') return String(data);

    const prefix = '  '.repeat(indent);
    const lines = [];

    for (const [key, value] of Object.entries(data)) {
      if (typeof value === 'object' && value !== null) {
        if (value.type === 'Uint8Array' || value.type === 'ArrayBuffer') {
          // Binary data preview
          lines.push(`${prefix}<span class="log-key">${key}:</span> <span class="log-binary">[${value.type}] ${value.length} bytes${value.truncated ? ' (truncated)' : ''}</span>`);
          lines.push(`${prefix}  <span class="log-preview">${value.preview}</span>`);
        } else {
          lines.push(`${prefix}<span class="log-key">${key}:</span>`);
          lines.push(formatData(value, indent + 1));
        }
      } else {
        lines.push(`${prefix}<span class="log-key">${key}:</span> <span class="log-value">${value}</span>`);
      }
    }

    return lines.join('\n');
  }

  // Plain text format for clipboard copy
  function formatDataPlain(data, indent = 0) {
    if (data === null || data === undefined) return 'null';
    if (typeof data !== 'object') return String(data);

    const prefix = '  '.repeat(indent);
    const lines = [];

    for (const [key, value] of Object.entries(data)) {
      if (typeof value === 'object' && value !== null) {
        if (value.type === 'Uint8Array' || value.type === 'ArrayBuffer') {
          lines.push(`${prefix}${key}: [${value.type}] ${value.length} bytes${value.truncated ? ' (truncated)' : ''}`);
          lines.push(`${prefix}  ${value.preview}`);
        } else {
          lines.push(`${prefix}${key}:`);
          lines.push(formatDataPlain(value, indent + 1));
        }
      } else {
        lines.push(`${prefix}${key}: ${value}`);
      }
    }

    return lines.join('\n');
  }

  function formatEventPlain(event) {
    const direction = EVENT_DIRECTION[event.eventType] || '';
    const dirArrow = direction === 'out' ? '↑' : direction === 'in' ? '↓' : direction === 'session' ? '⇄' : '↔';
    const time = formatTimestamp(event.timestamp);
    const type = formatEventType(event.eventType);

    let text = `[${time}] ${dirArrow} ${type} (${event.correlationId.slice(-6)})`;
    if (event.data && Object.keys(event.data).length > 0) {
      text += '\n' + formatDataPlain(event.data, 1);
    }
    return text;
  }

  function copyLogsToClipboard() {
    const filteredEvents = getFilteredEvents();
    const text = filteredEvents.map(formatEventPlain).join('\n\n');
    navigator.clipboard.writeText(text).then(() => {
      // Brief visual feedback
      const btn = container.querySelector('#copy-btn');
      if (btn) {
        btn.classList.add('copied');
        setTimeout(() => btn.classList.remove('copied'), 1500);
      }
    });
  }

  function render() {
    const filteredEvents = getFilteredEvents();

    container.innerHTML = `
      <div class="logs-view">
        <div class="logs-header">
          <h2>Message Logs</h2>
          <div class="logs-controls">
            <select id="log-filter" class="log-select">
              <option value="all" ${filter === 'all' ? 'selected' : ''}>All Events</option>
              <option value="send" ${filter === 'send' ? 'selected' : ''}>Send</option>
              <option value="receive" ${filter === 'receive' ? 'selected' : ''}>Receive</option>
              <option value="session" ${filter === 'session' ? 'selected' : ''}>Session</option>
              <option value="gateway" ${filter === 'gateway' ? 'selected' : ''}>Gateway</option>
            </select>
            <button id="copy-btn" class="log-btn" title="Copy All">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <rect x="9" y="9" width="13" height="13" rx="2" ry="2"/>
                <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>
              </svg>
            </button>
            <button id="refresh-btn" class="log-btn" title="Refresh">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <polyline points="23 4 23 10 17 10"/>
                <polyline points="1 20 1 14 7 14"/>
                <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/>
              </svg>
            </button>
            <button id="clear-btn" class="log-btn danger" title="Clear All">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <polyline points="3 6 5 6 21 6"/>
                <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>
              </svg>
            </button>
          </div>
        </div>

        <div class="logs-stats">
          <span class="stat">${filteredEvents.length} events</span>
          <span class="live-indicator">Live</span>
        </div>

        <div class="logs-list" id="logs-list">
          ${filteredEvents.length === 0 ? `
            <div class="logs-empty">
              <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
                <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
                <polyline points="14 2 14 8 20 8"/>
              </svg>
              <p>No events logged yet</p>
              <p class="hint">Send or receive messages to see logs here</p>
            </div>
          ` : filteredEvents.map(event => renderEvent(event)).join('')}
        </div>
      </div>
    `;

    attachListeners();
  }

  function renderEvent(event) {
    const color = EVENT_COLORS[event.eventType] || '#6b7280';
    const direction = EVENT_DIRECTION[event.eventType] || '';
    const isExpanded = expandedEvent === event.id;

    const directionIcon = direction === 'out'
      ? '<span class="direction out" title="Outbound">&#x2191;</span>'
      : direction === 'in'
        ? '<span class="direction in" title="Inbound">&#x2193;</span>'
        : direction === 'session'
          ? '<span class="direction session" title="Session">&#x21C4;</span>'
          : '<span class="direction gateway" title="Gateway">&#x2194;</span>';

    return `
      <div class="log-event ${isExpanded ? 'expanded' : ''}" data-id="${event.id}">
        <div class="log-event-header">
          ${directionIcon}
          <span class="log-time">${formatTimestamp(event.timestamp)}</span>
          <span class="log-type" style="background: ${color}">${formatEventType(event.eventType)}</span>
          <span class="log-corr" title="Correlation ID: ${event.correlationId}">${event.correlationId.slice(-6)}</span>
          <span class="log-expand">${isExpanded ? '&#x25BC;' : '&#x25B6;'}</span>
        </div>
        ${isExpanded ? `
          <div class="log-event-details">
            <div class="log-data-section">
              <div class="log-data-header">Event Data</div>
              <pre class="log-data">${formatData(event.data)}</pre>
            </div>
            <div class="log-meta">
              <div><span class="log-key">ID:</span> ${event.id}</div>
              <div><span class="log-key">Correlation:</span> ${event.correlationId}</div>
              <div><span class="log-key">Device:</span> ${event.deviceId}</div>
              <div><span class="log-key">Time:</span> ${new Date(event.timestamp).toISOString()}</div>
            </div>
          </div>
        ` : ''}
      </div>
    `;
  }

  function attachListeners() {
    // Filter select
    container.querySelector('#log-filter')?.addEventListener('change', (e) => {
      filter = e.target.value;
      render();
    });

    // Copy button
    container.querySelector('#copy-btn')?.addEventListener('click', copyLogsToClipboard);

    // Refresh button
    container.querySelector('#refresh-btn')?.addEventListener('click', async () => {
      await loadEvents();
      render();
    });

    // Clear button
    container.querySelector('#clear-btn')?.addEventListener('click', async () => {
      if (confirm('Clear all logs?')) {
        await logger.clearAll();
        events = [];
        render();
      }
    });

    // Event expansion
    container.querySelectorAll('.log-event').forEach(el => {
      el.addEventListener('click', () => {
        const id = parseInt(el.dataset.id, 10);
        expandedEvent = expandedEvent === id ? null : id;
        render();
      });
    });
  }

  // Render immediately with empty state, then load data
  render();
  loadEvents().then(() => {
    render();
    subscribe();
  });

  // Return instance for cleanup and visibility control
  return {
    render,
    cleanup: () => {
      if (unsubscribe) unsubscribe();
    },
    hide: () => {
      isVisible = false;
    },
    show: () => {
      isVisible = true;
      render();
    },
  };
}
