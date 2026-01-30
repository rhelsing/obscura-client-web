# Obscura Rails-Esque Architecture

> Minimal code, maximum magic. Convention over configuration.
> Real-time by default. Offline-first. Cryptographically signed.

## Philosophy

```
Rails says: "Convention over configuration"
We say:     "Convention over configuration, encryption over trust"
```

What Rails has:
- MVC with strong conventions
- ActiveRecord ORM
- ActionCable for real-time
- Turbo for SPA-like updates

What we already have that Rails doesn't:
- **CRDTs** - Conflict-free merge (G-Set, LWW-Map)
- **Cryptographic signing** - Every record signed by author
- **Offline-first** - IndexedDB with eventual sync
- **E2E encryption** - Signal protocol, zero server knowledge
- **Multi-device** - Fan-out, self-sync, device linking

## Directory Structure

```
src/v2/
├── app/
│   ├── controllers/
│   │   ├── ApplicationController.js
│   │   ├── StoriesController.js
│   │   ├── MessagesController.js
│   │   └── FriendsController.js
│   │
│   ├── models/
│   │   ├── ApplicationModel.js      # Was BaseModel
│   │   ├── Story.js
│   │   ├── Comment.js
│   │   ├── Reaction.js
│   │   ├── Profile.js
│   │   └── Message.js
│   │
│   ├── views/
│   │   ├── layouts/
│   │   │   └── application.js       # Nav, shell
│   │   ├── stories/
│   │   │   ├── index.js             # List
│   │   │   ├── show.js              # Detail
│   │   │   ├── _card.js             # Partial
│   │   │   └── _form.js             # Partial
│   │   └── shared/
│   │       ├── _empty.js
│   │       └── _loading.js
│   │
│   ├── channels/                     # Real-time subscriptions
│   │   ├── ApplicationChannel.js
│   │   ├── StoryChannel.js
│   │   └── ConversationChannel.js
│   │
│   └── concerns/                     # Mixins
│       ├── Syncable.js              # CRDT sync behavior
│       ├── Ephemeral.js             # TTL behavior
│       └── Signable.js              # Crypto signing
│
├── config/
│   ├── routes.js                    # Route definitions
│   ├── schema.js                    # Model registry
│   └── channels.js                  # Channel registry
│
├── lib/
│   ├── obscura/
│   │   ├── Client.js                # Core client
│   │   ├── Router.js                # Convention-based routing
│   │   ├── ActionController.js      # Base controller
│   │   ├── ActionView.js            # View renderer
│   │   ├── ActionChannel.js         # Real-time base
│   │   └── ActiveModel.js           # ORM base
│   │
│   └── crypto/                      # Unchanged
│
└── index.js                         # Boot
```

---

## Models (ActiveModel)

### Base Model

```javascript
// app/models/ApplicationModel.js
import { ActiveModel } from '../../lib/obscura/ActiveModel.js';
import { Syncable, Signable } from '../concerns/index.js';

export class ApplicationModel extends ActiveModel {
  static concerns = [Syncable, Signable];

  // Defaults for all models
  static sync = 'lww';
  static collectable = true;
}
```

### Model Definition (The Magic)

```javascript
// app/models/Story.js
import { ApplicationModel } from './ApplicationModel.js';
import { Ephemeral } from '../concerns/Ephemeral.js';

export class Story extends ApplicationModel {
  // Schema - that's it
  static fields = {
    content: 'string',
    mediaUrl: 'string?',
  };

  // Behavior
  static sync = 'g-set';           // Immutable, merge = union
  static concerns = [Ephemeral];   // Add TTL behavior
  static ttl = '24h';

  // Relations
  static has_many = ['comments', 'reactions'];

  // Scopes (chainable query helpers)
  static scopes = {
    recent: (q) => q.orderBy('timestamp', 'desc').limit(50),
    byAuthor: (q, authorId) => q.where({ authorDeviceId: authorId }),
    fromFriends: (q, friendIds) => q.where({ authorDeviceId: { in: friendIds } }),
  };

  // Computed
  get authorName() {
    return this.client.resolveAuthorName(this.authorDeviceId);
  }

  get timeAgo() {
    return formatTimeAgo(this.timestamp);
  }

  // Callbacks
  afterCreate() {
    // Auto-broadcast handled by Syncable concern
  }
}
```

### Usage (Zero Boilerplate)

```javascript
// Create
const story = await Story.create({ content: 'Hello world!' });

// Query with scopes
const stories = await Story.recent.fromFriends(friendIds).include('comments').exec();

// Find
const story = await Story.find('story_123');

// Update (LWW only)
await story.update({ content: 'Updated!' });

// Eager loading
await story.load('comments', 'reactions');
story.comments  // Already loaded
```

---

## Controllers (ActionController)

### Base Controller

```javascript
// lib/obscura/ActionController.js
export class ActionController {
  constructor(client, params = {}) {
    this.client = client;
    this.params = params;
  }

  // Render a view with data
  render(view, locals = {}) {
    return view({ ...locals, client: this.client });
  }

  // Redirect
  redirectTo(path) {
    this.client.router.navigate(path);
  }

  // Current user helpers
  get currentUser() { return this.client.username; }
  get currentDeviceId() { return this.client.deviceUUID; }

  // Flash messages
  flash(type, message) {
    this.client.flash[type] = message;
  }
}
```

### Controller Definition

```javascript
// app/controllers/StoriesController.js
import { ApplicationController } from './ApplicationController.js';
import { Story, Comment, Reaction, Profile } from '../models/index.js';
import * as views from '../views/stories/index.js';

export class StoriesController extends ApplicationController {

  // GET /stories
  async index() {
    const stories = await Story
      .recent
      .fromFriends(this.friendDeviceIds)
      .include('comments', 'reactions')
      .exec();

    // Resolve author names in batch
    await this.resolveAuthors(stories);

    return this.render(views.index, { stories });
  }

  // GET /stories/:id
  async show() {
    const story = await Story.find(this.params.id);
    if (!story) return this.redirectTo('/stories');

    await story.load('comments', 'reactions');

    return this.render(views.show, { story });
  }

  // POST /stories
  async create() {
    const story = await Story.create({
      content: this.params.content,
      mediaUrl: this.params.mediaUrl,
    });

    this.flash('success', 'Story posted!');
    return this.redirectTo('/stories');
  }

  // Helper
  get friendDeviceIds() {
    return this.client.friends.getAllDeviceIds();
  }

  async resolveAuthors(stories) {
    const profiles = await Profile.where({
      authorDeviceId: { in: stories.map(s => s.authorDeviceId) }
    }).exec();

    const profileMap = new Map(profiles.map(p => [p.authorDeviceId, p.data.displayName]));
    stories.forEach(s => s.authorName = profileMap.get(s.authorDeviceId) || 'Unknown');
  }
}
```

---

## Views (ActionView)

### Layouts

```javascript
// app/views/layouts/application.js
import { nav } from '../shared/_nav.js';

export function application({ content, activeTab, client }) {
  return `
    <div class="app-shell">
      <main class="content">
        ${content}
      </main>
      ${nav({ activeTab, client })}
    </div>
  `;
}
```

### View Template

```javascript
// app/views/stories/index.js
import { card } from './_card.js';
import { empty } from '../shared/_empty.js';
import { loading } from '../shared/_loading.js';

export function index({ stories = [], isLoading = false }) {
  if (isLoading) return loading({ message: 'Loading stories...' });
  if (!stories.length) return empty({ message: 'No stories yet', hint: 'Stories disappear after 24 hours' });

  return `
    <div class="stories-feed" data-channel="StoryChannel">
      <header>
        <h1>Feed</h1>
        <a href="/stories/new" class="btn-primary">+ New</a>
      </header>

      <div class="stories-list" data-target="stories">
        ${stories.map(card).join('')}
      </div>
    </div>
  `;
}
```

### Partials (Reusable Components)

```javascript
// app/views/stories/_card.js
export function card(story) {
  return `
    <article class="story-card"
             data-id="${story.id}"
             data-model="story"
             data-action="click->stories#show">
      <header>
        <strong>${story.authorName}</strong>
        <time>${story.timeAgo}</time>
      </header>

      <p>${escapeHtml(story.data.content)}</p>

      ${story.data.mediaUrl ? `
        <img src="${story.mediaBlobUrl}" loading="lazy" />
      ` : ''}

      <footer>
        <button data-action="click->reactions#toggle" data-story-id="${story.id}">
          ${formatReactions(story.reactions)}
        </button>
        <button data-action="click->stories#show">
          ${story.comments?.length || 0} comments
        </button>
      </footer>
    </article>
  `;
}
```

---

## Channels (Real-Time)

### Base Channel

```javascript
// lib/obscura/ActionChannel.js
export class ActionChannel {
  constructor(client) {
    this.client = client;
    this.subscriptions = [];
  }

  // Subscribe to model changes
  subscribe(modelName, callback) {
    const handler = (sync) => {
      if (sync.model === modelName) {
        callback(sync);
      }
    };
    this.client.on('modelSync', handler);
    this.subscriptions.push(['modelSync', handler]);
  }

  // Auto-rerender on changes
  subscribeAndRerender(modelName, containerSelector, renderFn) {
    this.subscribe(modelName, async () => {
      const container = document.querySelector(containerSelector);
      if (container) {
        container.innerHTML = await renderFn();
      }
    });
  }

  unsubscribeAll() {
    for (const [event, handler] of this.subscriptions) {
      this.client.off(event, handler);
    }
    this.subscriptions = [];
  }
}
```

### Story Channel (Declarative Real-Time)

```javascript
// app/channels/StoryChannel.js
import { ApplicationChannel } from './ApplicationChannel.js';
import { Story } from '../models/Story.js';
import { card } from '../views/stories/_card.js';

export class StoryChannel extends ApplicationChannel {

  // Called when view with data-channel="StoryChannel" mounts
  connected() {
    // New story → prepend to list
    this.subscribe('story', async (sync) => {
      if (sync.id.startsWith('story_')) {
        const story = await Story.find(sync.id);
        await story.load('comments', 'reactions');

        this.prepend('[data-target="stories"]', card(story));
      }
    });

    // New comment → update story card
    this.subscribe('comment', async (sync) => {
      const storyId = sync.data?.storyId;
      if (storyId) {
        const story = await Story.find(storyId);
        await story.load('comments', 'reactions');

        this.replace(`[data-id="${storyId}"]`, card(story));
      }
    });

    // New reaction → update story card
    this.subscribe('reaction', async (sync) => {
      const storyId = sync.data?.storyId;
      if (storyId) {
        const story = await Story.find(storyId);
        await story.load('reactions');

        this.updateReactions(`[data-id="${storyId}"]`, story.reactions);
      }
    });
  }

  // DOM helpers
  prepend(selector, html) {
    const container = document.querySelector(selector);
    if (container) container.insertAdjacentHTML('afterbegin', html);
  }

  replace(selector, html) {
    const el = document.querySelector(selector);
    if (el) el.outerHTML = html;
  }
}
```

---

## Router (Convention-Based)

### Route Definitions

```javascript
// config/routes.js
export function routes(router) {
  // Resources helper - generates RESTful routes
  router.resources('stories', { only: ['index', 'show', 'create'] });
  // → GET  /stories         → StoriesController#index
  // → GET  /stories/:id     → StoriesController#show
  // → POST /stories         → StoriesController#create

  router.resources('messages', { only: ['index', 'show', 'create'] });
  router.resources('friends', { only: ['index', 'create', 'destroy'] });
  router.resources('devices', { only: ['index', 'destroy'] });

  // Nested resources
  router.resources('stories', () => {
    router.resources('comments', { only: ['create'] });
    router.resources('reactions', { only: ['create', 'destroy'] });
  });
  // → POST /stories/:story_id/comments  → CommentsController#create

  // Custom routes
  router.get('/profile', 'profiles#show');
  router.get('/profile/edit', 'profiles#edit');
  router.post('/profile', 'profiles#update');

  // Auth routes (no controller prefix)
  router.get('/login', 'sessions#new');
  router.post('/login', 'sessions#create');
  router.delete('/logout', 'sessions#destroy');
  router.get('/register', 'registrations#new');
  router.post('/register', 'registrations#create');

  // Root
  router.root('stories#index');
}
```

### Router Implementation

```javascript
// lib/obscura/Router.js
import Navigo from 'navigo';

export class Router {
  constructor(client) {
    this.client = client;
    this.navigo = new Navigo('/');
    this.controllers = {};
    this.channels = {};
    this.currentChannel = null;
  }

  // Resource helper
  resources(name, optionsOrCallback, callback) {
    const options = typeof optionsOrCallback === 'function' ? {} : optionsOrCallback;
    const nested = typeof optionsOrCallback === 'function' ? optionsOrCallback : callback;

    const only = options.only || ['index', 'show', 'new', 'create', 'edit', 'update', 'destroy'];
    const controller = `${capitalize(name)}Controller`;

    if (only.includes('index'))   this.get(`/${name}`, `${name}#index`);
    if (only.includes('new'))     this.get(`/${name}/new`, `${name}#new`);
    if (only.includes('show'))    this.get(`/${name}/:id`, `${name}#show`);
    if (only.includes('create'))  this.post(`/${name}`, `${name}#create`);
    if (only.includes('edit'))    this.get(`/${name}/:id/edit`, `${name}#edit`);
    if (only.includes('update'))  this.patch(`/${name}/:id`, `${name}#update`);
    if (only.includes('destroy')) this.delete(`/${name}/:id`, `${name}#destroy`);

    if (nested) {
      // Handle nested resources
      this._nestedParent = name;
      nested();
      this._nestedParent = null;
    }
  }

  get(path, action) { this._route('GET', path, action); }
  post(path, action) { this._route('POST', path, action); }
  patch(path, action) { this._route('PATCH', path, action); }
  delete(path, action) { this._route('DELETE', path, action); }
  root(action) { this.get('/', action); }

  _route(method, path, action) {
    const [controllerName, actionName] = action.split('#');

    this.navigo.on(path, async ({ data, params }) => {
      await this._dispatch(controllerName, actionName, { ...data, ...params });
    });
  }

  async _dispatch(controllerName, actionName, params) {
    // Cleanup previous channel
    if (this.currentChannel) {
      this.currentChannel.unsubscribeAll();
    }

    // Get controller class
    const Controller = this.controllers[controllerName];
    if (!Controller) throw new Error(`Controller not found: ${controllerName}`);

    // Instantiate and call action
    const controller = new Controller(this.client, params);
    const html = await controller[actionName]();

    // Render to container
    this.client.container.innerHTML = html;

    // Bind actions (data-action attributes)
    this._bindActions(controller);

    // Connect channel if present
    const channelName = document.querySelector('[data-channel]')?.dataset.channel;
    if (channelName && this.channels[channelName]) {
      const Channel = this.channels[channelName];
      this.currentChannel = new Channel(this.client);
      this.currentChannel.connected();
    }

    // Update Navigo links
    this.navigo.updatePageLinks();
  }

  _bindActions(controller) {
    document.querySelectorAll('[data-action]').forEach(el => {
      const [event, action] = el.dataset.action.split('->');
      const [ctrlName, methodName] = action.split('#');

      el.addEventListener(event, async (e) => {
        e.preventDefault();

        // Collect params from data attributes
        const params = { ...el.dataset };
        delete params.action;

        // Dispatch
        await this._dispatch(ctrlName, methodName, params);
      });
    });
  }

  navigate(path) {
    this.navigo.navigate(path);
  }

  start() {
    this.navigo.resolve();
  }
}
```

---

## Concerns (Mixins)

### Syncable (CRDT Broadcast)

```javascript
// app/concerns/Syncable.js
export const Syncable = (Base) => class extends Base {

  // After creating, broadcast to peers
  async afterCreate(entry) {
    await super.afterCreate?.(entry);
    await this.broadcast(entry);
  }

  // After receiving sync, merge via CRDT
  async handleSync(syncData, sourceUserId) {
    const entry = this.decodeEntry(syncData);

    // Verify signature
    if (!await this.verifySignature(entry)) {
      console.warn('Invalid signature, rejecting sync');
      return null;
    }

    // Merge via CRDT
    return this.crdt.merge([entry]);
  }

  // Broadcast to friends + self devices
  async broadcast(entry) {
    const targets = [
      ...this.client.friends.getAllServerUserIds(),
      ...this.client.devices.getSelfSyncTargets(),
    ];

    for (const target of targets) {
      await this.client.messenger.sendMessage(target, {
        type: 'MODEL_SYNC',
        modelSync: {
          model: this.constructor.modelName,
          id: entry.id,
          data: entry.data,
          timestamp: entry.timestamp,
          authorDeviceId: entry.authorDeviceId,
          signature: entry.signature,
        },
      });
    }
  }
};
```

### Ephemeral (TTL)

```javascript
// app/concerns/Ephemeral.js
export const Ephemeral = (Base) => class extends Base {

  async afterCreate(entry) {
    await super.afterCreate?.(entry);

    // Schedule expiration
    const ttlMs = this.parseTTL(this.constructor.ttl);
    await this.client.ttlManager.schedule(
      this.constructor.modelName,
      entry.id,
      ttlMs
    );
  }

  parseTTL(ttl) {
    if (typeof ttl === 'number') return ttl;
    const match = ttl.match(/^(\d+)(h|m|s)$/);
    if (!match) return 24 * 60 * 60 * 1000; // Default 24h
    const [, num, unit] = match;
    const multipliers = { h: 3600000, m: 60000, s: 1000 };
    return parseInt(num) * multipliers[unit];
  }

  // Check if expired
  get isExpired() {
    const ttlMs = this.parseTTL(this.constructor.ttl);
    return Date.now() > this.timestamp + ttlMs;
  }

  // Time remaining
  get expiresIn() {
    const ttlMs = this.parseTTL(this.constructor.ttl);
    return Math.max(0, (this.timestamp + ttlMs) - Date.now());
  }
};
```

### Signable (Crypto)

```javascript
// app/concerns/Signable.js
export const Signable = (Base) => class extends Base {

  async beforeCreate(entry) {
    await super.beforeCreate?.(entry);

    // Sign the entry
    entry.signature = await this.sign(entry);
  }

  async sign(entry) {
    const dataToSign = JSON.stringify({
      model: this.constructor.modelName,
      id: entry.id,
      data: entry.data,
      timestamp: entry.timestamp,
      authorDeviceId: entry.authorDeviceId,
    });

    return this.client.crypto.sign(dataToSign);
  }

  async verifySignature(entry) {
    const dataToSign = JSON.stringify({
      model: this.constructor.modelName,
      id: entry.id,
      data: entry.data,
      timestamp: entry.timestamp,
      authorDeviceId: entry.authorDeviceId,
    });

    // Get author's public key
    const publicKey = await this.client.getPublicKeyForDevice(entry.authorDeviceId);
    if (!publicKey) return false;

    return this.client.crypto.verify(dataToSign, entry.signature, publicKey);
  }
};
```

---

## Boot Sequence

```javascript
// index.js
import { Client } from './lib/obscura/Client.js';
import { Router } from './lib/obscura/Router.js';
import { routes } from './config/routes.js';
import { schema } from './config/schema.js';
import * as controllers from './app/controllers/index.js';
import * as channels from './app/channels/index.js';

async function boot() {
  // 1. Restore or create client
  const client = Client.restore() || await Client.create();

  // 2. Initialize ORM with schema
  await client.schema(schema);

  // 3. Setup router
  const router = new Router(client);
  router.controllers = controllers;
  router.channels = channels;
  routes(router);

  // 4. Connect to gateway
  await client.connect();

  // 5. Mount to DOM
  client.container = document.getElementById('app');
  router.start();
}

boot().catch(console.error);
```

---

## Full Example: Stories Feature

### Model

```javascript
// app/models/Story.js
export class Story extends ApplicationModel {
  static fields = { content: 'string', mediaUrl: 'string?' };
  static sync = 'g-set';
  static ttl = '24h';
  static has_many = ['comments', 'reactions'];
  static concerns = [Ephemeral];

  static scopes = {
    recent: q => q.orderBy('timestamp', 'desc'),
    fromFriends: (q, ids) => q.where({ authorDeviceId: { in: ids } }),
  };
}
```

### Controller

```javascript
// app/controllers/StoriesController.js
export class StoriesController extends ApplicationController {
  async index() {
    const stories = await Story.recent.fromFriends(this.friendIds).include('comments', 'reactions').exec();
    return this.render(views.index, { stories });
  }

  async show() {
    const story = await Story.find(this.params.id);
    await story.load('comments', 'reactions');
    return this.render(views.show, { story });
  }

  async create() {
    await Story.create(this.storyParams);
    this.redirectTo('/stories');
  }

  get storyParams() {
    return { content: this.params.content, mediaUrl: this.params.mediaUrl };
  }
}
```

### View

```javascript
// app/views/stories/index.js
export function index({ stories }) {
  return `
    <div data-channel="StoryChannel">
      <div data-target="stories">
        ${stories.map(card).join('')}
      </div>
    </div>
  `;
}
```

### Channel

```javascript
// app/channels/StoryChannel.js
export class StoryChannel extends ApplicationChannel {
  connected() {
    this.subscribe('story', async (sync) => {
      const story = await Story.find(sync.id);
      this.prepend('[data-target="stories"]', card(story));
    });
  }
}
```

### Routes

```javascript
// config/routes.js
router.resources('stories', { only: ['index', 'show', 'create'] });
```

**That's it.** Full CRUD, real-time updates, CRDT sync, crypto signing, TTL expiration.

---

## Magic Summary

| Feature | Rails | Obscura Rails-Esque |
|---------|-------|---------------------|
| ORM | ActiveRecord | ActiveModel + CRDTs |
| Real-time | ActionCable | Channels (built-in) |
| Routing | routes.rb | routes.js (same DSL) |
| Controllers | ActionController | ActionController |
| Views | ERB/Haml | Template literals |
| Persistence | PostgreSQL | IndexedDB + Sync |
| Auth | Devise | Signal Protocol |
| Encryption | None (HTTPS) | E2E (Signal) |
| Offline | No | Yes (offline-first) |
| Conflict resolution | Last write wins | CRDTs (configurable) |

## Convention Wins

1. **Model name → table name** (story → stories store)
2. **Controller name → routes** (StoriesController → /stories/*)
3. **has_many → auto-includes** (story.comments just works)
4. **data-channel → auto-subscribe** (mount = connect)
5. **data-action → auto-bind** (click->stories#show)
6. **sync type → CRDT selection** (g-set, lww)
7. **ttl → auto-expiration** (24h = scheduled cleanup)
