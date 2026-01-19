// Use proxy in development, direct URL in production
const isDev = import.meta.env.DEV;
const API_URL = import.meta.env.VITE_API_URL;
const API_BASE = isDev ? '/api' : API_URL;
const WS_BASE = isDev ? `ws://${location.host}/ws` : API_URL.replace('https://', 'wss://');

class ObscuraClient {
  constructor() {
    this.token = null;
    this.refreshToken = null;
    this.expiresAt = null;
  }

  setTokens({ token, refreshToken, expiresAt }) {
    this.token = token;
    this.refreshToken = refreshToken;
    this.expiresAt = expiresAt;
    localStorage.setItem('obscura_auth', JSON.stringify({ token, refreshToken, expiresAt }));
  }

  loadTokens() {
    const stored = localStorage.getItem('obscura_auth');
    if (stored) {
      const { token, refreshToken, expiresAt } = JSON.parse(stored);
      this.token = token;
      this.refreshToken = refreshToken;
      this.expiresAt = expiresAt;
      return true;
    }
    return false;
  }

  clearTokens() {
    this.token = null;
    this.refreshToken = null;
    this.expiresAt = null;
    localStorage.removeItem('obscura_auth');
  }

  isAuthenticated() {
    return this.token && this.expiresAt && Date.now() < this.expiresAt * 1000;
  }

  // Decode JWT payload to get user info
  getUserId() {
    if (!this.token) return null;
    try {
      const payload = this.token.split('.')[1];
      const decoded = JSON.parse(atob(payload));
      // Common JWT claim names for user ID
      return decoded.sub || decoded.user_id || decoded.userId || decoded.id;
    } catch (e) {
      console.warn('Could not decode JWT:', e);
      return null;
    }
  }

  getTokenPayload() {
    if (!this.token) return null;
    try {
      const payload = this.token.split('.')[1];
      return JSON.parse(atob(payload));
    } catch (e) {
      return null;
    }
  }

  async request(path, options = {}) {
    const url = `${API_BASE}${path}`;
    const headers = {
      'Content-Type': 'application/json',
      ...options.headers,
    };

    if (this.token && options.auth !== false) {
      headers['Authorization'] = `Bearer ${this.token}`;
    }

    const response = await fetch(url, {
      ...options,
      headers,
    });

    if (!response.ok) {
      const error = new Error(`HTTP ${response.status}`);
      error.status = response.status;
      try {
        error.body = await response.json();
      } catch {
        error.body = await response.text();
      }
      throw error;
    }

    const contentType = response.headers.get('content-type');
    if (contentType?.includes('application/json')) {
      return response.json();
    }
    return response.text();
  }

  // Account endpoints
  async register({ username, password, identityKey, registrationId, signedPreKey, oneTimePreKeys }) {
    const result = await this.request('/v1/users', {
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
    this.setTokens(result);
    return result;
  }

  async login(username, password) {
    const result = await this.request('/v1/sessions', {
      method: 'POST',
      auth: false,
      body: JSON.stringify({ username, password }),
    });
    this.setTokens(result);
    return result;
  }

  async logout() {
    if (this.refreshToken) {
      try {
        await this.request('/v1/sessions', {
          method: 'DELETE',
          body: JSON.stringify({ refreshToken: this.refreshToken }),
        });
      } catch (e) {
        console.warn('Logout request failed:', e);
      }
    }
    this.clearTokens();
  }

  async refreshSession() {
    if (!this.refreshToken) {
      throw new Error('No refresh token available');
    }
    const result = await this.request('/v1/sessions/refresh', {
      method: 'POST',
      auth: false,
      body: JSON.stringify({ refreshToken: this.refreshToken }),
    });
    this.setTokens(result);
    return result;
  }

  // Key endpoints
  async uploadKeys({ identityKey, registrationId, signedPreKey, oneTimePreKeys }) {
    return this.request('/v1/keys', {
      method: 'POST',
      body: JSON.stringify({
        identityKey,
        registrationId,
        signedPreKey,
        oneTimePreKeys,
      }),
    });
  }

  async fetchPreKeyBundle(userId) {
    return this.request(`/v1/keys/${userId}`);
  }

  // Messaging
  async sendMessage(recipientId, protobufData) {
    const url = `${API_BASE}/v1/messages/${recipientId}`;
    console.log('=== SENDING MESSAGE ===');
    console.log('Recipient:', recipientId);
    console.log('Protobuf size:', protobufData.length, 'bytes');
    console.log('Protobuf data:', protobufData);

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-protobuf',
        'Authorization': `Bearer ${this.token}`,
      },
      body: protobufData,
    });

    if (!response.ok) {
      const errorBody = await response.text().catch(() => '(could not read body)');
      console.log('%c SEND ERROR ', 'background: red; color: white; font-size: 16px');
      console.log('Status:', response.status);
      console.log('Body:', errorBody);
      const error = new Error(`HTTP ${response.status}: ${errorBody}`);
      error.status = response.status;
      error.body = errorBody;
      throw error;
    }

    console.log('=== MESSAGE SENT OK ===');
    return response;
  }

  getGatewayUrl() {
    return `${WS_BASE}/v1/gateway?token=${encodeURIComponent(this.token)}`;
  }
}

export const client = new ObscuraClient();
export default client;
