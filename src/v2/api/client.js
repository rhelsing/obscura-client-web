/**
 * HTTP API Client for Obscura Server
 * Per identity.md spec: Interacts with server endpoints
 *
 * Pure functional - does NOT auto-store tokens (auth layer handles that)
 */

// Get API URL from environment
const API_URL = typeof process !== 'undefined' && process.env?.VITE_API_URL
  ? process.env.VITE_API_URL
  : (typeof import.meta !== 'undefined' ? import.meta.env?.VITE_API_URL : null);

/**
 * Create an API client instance
 * @param {string} baseUrl - API base URL (defaults to VITE_API_URL)
 * @returns {object} API client
 */
export function createClient(baseUrl = API_URL) {
  if (!baseUrl) {
    throw new Error('API URL not configured. Set VITE_API_URL environment variable.');
  }

  let token = null;

  /**
   * Make an HTTP request
   */
  async function request(path, options = {}) {
    const url = `${baseUrl}${path}`;
    const headers = {
      'Content-Type': 'application/json',
      ...options.headers,
    };

    if (token && options.auth !== false) {
      headers['Authorization'] = `Bearer ${token}`;
    }

    const response = await fetch(url, {
      ...options,
      headers,
    });

    if (!response.ok) {
      const error = new Error(`HTTP ${response.status}`);
      error.status = response.status;
      try {
        const text = await response.text();
        try {
          error.body = JSON.parse(text);
        } catch {
          error.body = text;
        }
      } catch {
        error.body = '';
      }
      throw error;
    }

    const contentType = response.headers.get('content-type');
    if (contentType?.includes('application/json')) {
      return response.json();
    }
    return response.text();
  }

  return {
    /**
     * Set the auth token for requests
     */
    setToken(t) {
      token = t;
    },

    /**
     * Get current token
     */
    getToken() {
      return token;
    },

    /**
     * Clear the auth token
     */
    clearToken() {
      token = null;
    },

    /**
     * Register a shell account (reserves namespace)
     * Per identity.md: Shell reserves namespace
     *
     * NOTE: Server requires keys for all accounts, so shell gets minimal keys
     * that will never be used for messaging (only password validation)
     */
    async registerShell(username, password, keys) {
      // Keys are required by server but shell won't be used for messaging
      return request('/v1/users', {
        method: 'POST',
        auth: false,
        body: JSON.stringify({
          username,
          password,
          identityKey: keys?.identityKey || '',
          registrationId: keys?.registrationId || 1,
          signedPreKey: keys?.signedPreKey || { keyId: 1, publicKey: '', signature: '' },
          oneTimePreKeys: keys?.oneTimePreKeys || [],
        }),
      });
    },

    /**
     * Register a device account (with Signal keys)
     * Per identity.md: Device account used for all operations
     */
    async registerDevice({ username, password, identityKey, registrationId, signedPreKey, oneTimePreKeys }) {
      return request('/v1/users', {
        method: 'POST',
        auth: false,
        body: JSON.stringify({
          username,
          password,
          identityKey,
          registrationId,
          signedPreKey,
          oneTimePreKeys,
        }),
      });
    },

    /**
     * Login (get JWT token)
     */
    async login(username, password) {
      return request('/v1/sessions', {
        method: 'POST',
        auth: false,
        body: JSON.stringify({ username, password }),
      });
    },

    /**
     * Logout (invalidate refresh token)
     */
    async logout(refreshToken) {
      return request('/v1/sessions', {
        method: 'DELETE',
        body: JSON.stringify({ refreshToken }),
      });
    },

    /**
     * Refresh session token
     */
    async refreshSession(refreshToken) {
      return request('/v1/sessions/refresh', {
        method: 'POST',
        auth: false,
        body: JSON.stringify({ refreshToken }),
      });
    },

    /**
     * Upload keys (prekey replenishment)
     */
    async uploadKeys({ identityKey, registrationId, signedPreKey, oneTimePreKeys }) {
      return request('/v1/keys', {
        method: 'POST',
        body: JSON.stringify({
          identityKey,
          registrationId,
          signedPreKey,
          oneTimePreKeys,
        }),
      });
    },

    /**
     * Fetch prekey bundle for a user
     */
    async fetchPreKeyBundle(userId) {
      return request(`/v1/keys/${userId}`);
    },

    /**
     * Send a message (protobuf binary)
     */
    async sendMessage(recipientId, protobufData) {
      const url = `${baseUrl}/v1/messages/${recipientId}`;

      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-protobuf',
          'Authorization': `Bearer ${token}`,
        },
        body: protobufData,
      });

      if (!response.ok) {
        const error = new Error(`HTTP ${response.status}`);
        error.status = response.status;
        error.body = await response.text().catch(() => '');
        throw error;
      }

      return response;
    },

    /**
     * Upload attachment (binary blob)
     */
    async uploadAttachment(blob) {
      const url = `${baseUrl}/v1/attachments`;

      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/octet-stream',
          'Authorization': `Bearer ${token}`,
        },
        body: blob,
      });

      if (!response.ok) {
        const error = new Error(`HTTP ${response.status}`);
        error.status = response.status;
        throw error;
      }

      return response.json(); // { id, expiresAt }
    },

    /**
     * Fetch attachment (binary blob)
     */
    async fetchAttachment(id) {
      const url = `${baseUrl}/v1/attachments/${id}`;

      const response = await fetch(url, {
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${token}`,
        },
      });

      if (!response.ok) {
        const error = new Error(`HTTP ${response.status}`);
        error.status = response.status;
        throw error;
      }

      return new Uint8Array(await response.arrayBuffer());
    },

    /**
     * Get WebSocket gateway URL
     */
    getGatewayUrl() {
      const wsBase = baseUrl.replace('https://', 'wss://').replace('http://', 'ws://');
      return `${wsBase}/v1/gateway?token=${encodeURIComponent(token)}`;
    },

    /**
     * Decode JWT payload
     */
    decodeToken(t = token) {
      if (!t) return null;
      try {
        const payload = t.split('.')[1];
        return JSON.parse(atob(payload));
      } catch {
        return null;
      }
    },

    /**
     * Get user ID from token
     */
    getUserId(t = token) {
      const payload = this.decodeToken(t);
      return payload?.sub || payload?.user_id || payload?.userId || payload?.id || null;
    },
  };
}

// Default export for simple usage
export default createClient;
