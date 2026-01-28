#!/usr/bin/env node
/**
 * E2E Tests using clean Obscura API
 * Run: source .env && node src/v2/test/e2e-clean.js
 */
import '../../../test/helpers/setup.js'; // Polyfills for Node.js
import { Obscura } from '../lib/index.js';

const API = process.env.VITE_API_URL || process.env.OBSCURA_API_URL;
if (!API) {
  console.error('Error: VITE_API_URL required');
  process.exit(1);
}

const ts = Date.now();

// Test helper: wrap on() in a promise for sequential tests
const once = (client, event, ms = 15000) => new Promise((ok, fail) => {
  const t = setTimeout(() => {
    client.off(event, handler);
    fail(new Error(`Timeout: ${event}`));
  }, ms);
  const handler = (data) => {
    clearTimeout(t);
    client.off(event, handler);
    ok(data);
  };
  client.on(event, handler);
});

const delay = (ms) => new Promise(r => setTimeout(r, ms));
const ok = (name) => console.log(`  ✓ ${name}`);

async function main() {
  console.log(`\n${'='.repeat(50)}`);
  console.log('OBSCURA CLEAN API E2E TESTS');
  console.log(`Server: ${API}`);
  console.log(`${'='.repeat(50)}\n`);

  // --- Registration ---
  const alice = await Obscura.register(`alice_${ts}`, 'pass', { apiUrl: API });
  const phrase = alice.getRecoveryPhrase();
  if (!phrase || phrase.split(' ').length !== 12) throw new Error('Bad phrase');
  ok('Register alice + recovery phrase');
  await delay(300);

  const bob = await Obscura.register(`bob_${ts}`, 'pass', { apiUrl: API });
  ok('Register bob');
  await delay(300);

  // --- Login existing ---
  const r = await Obscura.login(`alice_${ts}`, 'pass', { apiUrl: API, store: alice.store });
  if (r.status !== 'ok') throw new Error(`Login failed: ${r.reason}`);
  ok('Login existing device');
  await delay(300);

  // --- Friend flow ---
  await alice.connect();
  await bob.connect();
  ok('Connected');
  await delay(300);

  // Register handlers BEFORE sending to avoid race
  const reqPromise = once(bob, 'friendRequest');
  const respPromise = once(alice, 'friendResponse');

  await alice.befriend(bob.userId, bob.username);
  const req = await reqPromise;
  await req.accept();
  await delay(300);

  const resp = await respPromise;
  if (!resp.accepted) throw new Error('Not accepted');
  ok('Friend flow');
  await delay(300);

  // --- P1: Verify Code ---
  const verifyCode = await req.getVerifyCode();
  if (!/^\d{4}$/.test(verifyCode)) throw new Error(`Bad verify code format: ${verifyCode}`);
  const myCode = await alice.getMyVerifyCode();
  if (!/^\d{4}$/.test(myCode)) throw new Error(`Bad my verify code format: ${myCode}`);
  ok('4-digit verify codes');
  await delay(300);

  // --- Message ---
  await alice.send(bob.username, { text: 'Hello!' });
  const msg = await once(bob, 'message');
  if (msg.text !== 'Hello!') throw new Error(`Wrong text: ${msg.text}`);
  ok('Send message');
  await delay(300);

  // --- Multi-device ---
  const loginResult = await Obscura.login(`bob_${ts}`, 'pass', { apiUrl: API });
  if (loginResult.status !== 'newDevice') throw new Error('Expected newDevice');
  const bob2 = loginResult.client;
  await bob2.connect();
  await delay(300);

  // bob2 should receive linkApproval AND syncBlob
  const approvalPromise = once(bob2, 'linkApproval');
  const syncPromise = once(bob2, 'syncBlob');
  await bob.approveLink(bob2.linkCode);
  const approval = await approvalPromise;
  approval.apply();
  await syncPromise;  // Wait for sync to arrive and be processed
  await delay(300);

  // Verify bob2 now has alice as a friend (synced from bob)
  const bob2Alice = bob2.friends.get(alice.username);
  if (!bob2Alice) throw new Error('bob2 should have alice as friend after sync');
  if (bob2Alice.status !== 'accepted') throw new Error('bob2 friend status should be accepted');
  ok('Friend sync via SYNC_BLOB');

  await bob.announceDevices();
  const announce = await once(alice, 'deviceAnnounce');
  await announce.apply();  // apply() is now async
  ok('Link second device');
  await delay(300);

  // --- P0: Link Code Replay Rejection ---
  try {
    await bob.approveLink(bob2.linkCode);  // Same code again
    throw new Error('Should reject replay');
  } catch (e) {
    if (!e.message.includes('already used')) throw e;
  }
  ok('Link code replay rejected');
  await delay(300);

  // Register handlers BEFORE sending to avoid race condition
  const p1 = once(bob, 'message');
  const p2 = once(bob2, 'message');
  await alice.send(bob.username, { text: 'Both!' });
  const [m1, m2] = await Promise.all([p1, p2]);
  if (m1.text !== 'Both!' || m2.text !== 'Both!') throw new Error('Fan-out failed');
  ok('Multi-device fan-out');
  await delay(300);

  // Verify bob2 can send to alice (friend was synced)
  const aliceMsgPromise = once(alice, 'message');
  await bob2.send(alice.username, { text: 'Hello from bob2!' });
  const aliceMsg = await aliceMsgPromise;
  if (aliceMsg.text !== 'Hello from bob2!') throw new Error('bob2 -> alice failed');
  ok('bob2 can send to synced friend');
  await delay(300);

  // --- Self-sync ---
  const aliceLogin = await Obscura.login(`alice_${ts}`, 'pass', { apiUrl: API });
  if (aliceLogin.status !== 'newDevice') throw new Error('Expected newDevice for alice2');
  const alice2 = aliceLogin.client;
  await alice2.connect();
  await delay(300);

  // Register handlers before approving
  const alice2ApprovalPromise = once(alice2, 'linkApproval');
  const alice2SyncPromise = once(alice2, 'syncBlob');
  await alice.approveLink(alice2.linkCode);
  const alice2Approval = await alice2ApprovalPromise;
  alice2Approval.apply();
  await alice2SyncPromise;
  await delay(300);

  await alice.send(bob.username, { text: 'Sync!' });
  const sync = await once(alice2, 'sentSync');
  if (sync.conversationId !== bob.username) throw new Error('Sync failed');
  ok('Self-sync');
  await delay(300);

  // --- Attachments ---
  // Upload once, send to multiple recipients (bob + bob2)
  const attachmentPromise = once(bob, 'attachment');
  const attachmentPromise2 = once(bob2, 'attachment');
  const testContent = new TextEncoder().encode('secret image data');
  await alice.sendAttachment(bob.username, testContent);
  const [attach1, attach2] = await Promise.all([attachmentPromise, attachmentPromise2]);
  if (!attach1.contentReference || !attach2.contentReference) throw new Error('Missing contentReference');
  ok('Attachment fan-out to all devices');
  await delay(300);

  // Download and verify integrity
  const downloaded = await bob.attachments.download(attach1.contentReference);
  const downloadedText = new TextDecoder().decode(downloaded);
  if (downloadedText !== 'secret image data') throw new Error(`Attachment corrupted: ${downloadedText}`);
  ok('Attachment download + decrypt');
  await delay(300);

  // --- Device Revocation (with recovery phrase) ---
  // alice revokes alice2 using recovery phrase, bob should see updated device list
  const revokePromise = once(bob, 'deviceAnnounce');
  await alice.revokeDevice(phrase, alice2.deviceUUID);  // Requires recovery phrase
  const revokeAnnounce = await revokePromise;
  if (!revokeAnnounce.isRevocation) throw new Error('Expected isRevocation');
  // Verify signature is present (not zeros)
  if (!revokeAnnounce.signature || revokeAnnounce.signature.every(b => b === 0)) {
    throw new Error('Revocation signature should not be zeros');
  }
  await revokeAnnounce.apply();  // apply() is now async
  ok('Device revocation with signed announcement');
  await delay(300);

  // Verify bob no longer has alice2 in device list
  const aliceFriend = bob.friends.get(alice.username);
  const hasAlice2 = aliceFriend.devices.some(d => d.deviceUUID === alice2.deviceUUID);
  if (hasAlice2) throw new Error('Revoked device should be removed');
  ok('Revoked device removed from friend list');
  await delay(300);

  // --- P0: Wrong Phrase Rejection ---
  try {
    await alice.revokeDevice('wrong wrong wrong wrong wrong wrong wrong wrong wrong wrong wrong wrong', alice.deviceUUID);
    throw new Error('Should reject wrong phrase');
  } catch (e) {
    if (!e.message.includes('Invalid recovery phrase')) throw e;
  }
  ok('Wrong recovery phrase rejected');
  await delay(300);

  // --- Link alice3 for ORM self-sync testing ---
  const alice3Login = await Obscura.login(`alice_${ts}`, 'pass', { apiUrl: API });
  if (alice3Login.status !== 'newDevice') throw new Error('Expected newDevice for alice3');
  const alice3 = alice3Login.client;
  await alice3.connect();
  await delay(300);

  const alice3ApprovalPromise = once(alice3, 'linkApproval');
  const alice3SyncPromise = once(alice3, 'syncBlob');
  await alice.approveLink(alice3.linkCode);
  const alice3Approval = await alice3ApprovalPromise;
  alice3Approval.apply();
  await alice3SyncPromise;
  await delay(500);

  // Register handlers BEFORE announcing (bob has 2 devices now)
  const alice3AnnouncePromise = once(bob, 'deviceAnnounce');
  const alice3AnnouncePromise2 = once(bob2, 'deviceAnnounce');
  await alice.announceDevices();
  const [alice3Announce, alice3Announce2] = await Promise.all([alice3AnnouncePromise, alice3AnnouncePromise2]);
  await alice3Announce.apply();
  await alice3Announce2.apply();
  ok('Link alice3 for ORM tests');
  await delay(300);

  // ==========================================================================
  // ORM LAYER TESTS (Level 3)
  // ==========================================================================

  // --- Define FULL schema on all clients ---
  const fullSchema = {
    // EPHEMERAL MODELS
    story: {
      fields: { content: 'string', mediaUrl: 'string?' },
      has_many: ['comment', 'reaction'],
      sync: 'g-set',
      ephemeral: true,
      ttl: '24h',
    },
    comment: {
      fields: { text: 'string' },
      belongs_to: ['story', 'comment'],
      has_many: ['comment', 'reaction'],
      sync: 'g-set',
      ephemeral: true,
      ttl: '24h',
    },
    reaction: {
      fields: { emoji: 'string' },
      belongs_to: ['story', 'comment'],
      sync: 'lww',
      ephemeral: true,
      ttl: '24h',
    },

    // COLLECTABLE MODELS
    streak: {
      fields: { count: 'number', lastActivity: 'timestamp' },
      sync: 'lww',
      collectable: true,
    },
    profile: {
      fields: { displayName: 'string', avatarUrl: 'string?', bio: 'string?' },
      sync: 'lww',
      collectable: true,
    },
    settings: {
      fields: { theme: 'string', notificationsEnabled: 'boolean' },
      sync: 'lww',
      collectable: true,
      private: true,  // Only syncs to own devices
    },

    // GROUP MODELS (for testing group targeting)
    group: {
      fields: { name: 'string', members: 'string' },  // members = JSON array of usernames
      has_many: ['groupMessage'],
      sync: 'g-set',
      collectable: true,
    },
    groupMessage: {
      fields: { text: 'string' },
      belongs_to: 'group',
      sync: 'g-set',
      ephemeral: true,
      ttl: '7d',
    },
  };

  await alice.schema(fullSchema);
  await alice3.schema(fullSchema);
  await bob.schema(fullSchema);
  await bob2.schema(fullSchema);
  ok('Full schema defined (6 models)');
  await delay(300);

  // --- Test 1: Auto-generation (ID, timestamp, signature, author) ---
  const bobSyncPromise = once(bob, 'modelSync');
  const bob2SyncPromise = once(bob2, 'modelSync');

  const story = await alice.story.create({ content: 'Hello ORM!' });

  // Validate auto-generated fields
  if (!story.id.startsWith('story_')) throw new Error(`ID not auto-generated: ${story.id}`);
  if (!story.timestamp || story.timestamp < Date.now() - 5000) throw new Error('Timestamp not auto-generated');
  if (!story.signature || story.signature.length === 0) throw new Error('Not signed');
  if (story.authorDeviceId !== alice.deviceUUID) throw new Error('Author not set');
  if (story.data.content !== 'Hello ORM!') throw new Error('Data not stored');
  ok('Auto-generation: ID, timestamp, signature, author');
  await delay(300);

  // --- Test 2: Local persistence ---
  const localStory = await alice.story.find(story.id);
  if (!localStory) throw new Error('Not persisted locally');
  if (localStory.data.content !== 'Hello ORM!') throw new Error('Local data corrupted');
  ok('Local persistence');
  await delay(300);

  // --- Test 3: Fan-out to ALL friend devices ---
  const [bobReceived, bob2Received] = await Promise.all([bobSyncPromise, bob2SyncPromise]);
  if (bobReceived.id !== story.id) throw new Error('bob didnt receive');
  if (bob2Received.id !== story.id) throw new Error('bob2 didnt receive (fan-out broken)');
  ok('Fan-out to all friend devices');
  await delay(300);

  // --- Test 3b: ORM self-sync to own devices ---
  const alice3ModelSyncPromise = once(alice3, 'modelSync');
  const selfSyncStory = await alice.story.create({ content: 'Self-sync test!' });
  const alice3Received = await alice3ModelSyncPromise;
  if (alice3Received.id !== selfSyncStory.id) throw new Error('ORM self-sync failed');
  // Decode the data (comes as Uint8Array from protobuf)
  const decodedData = JSON.parse(new TextDecoder().decode(alice3Received.data));
  if (decodedData.content !== 'Self-sync test!') throw new Error(`Self-sync data wrong: ${decodedData.content}`);
  ok('ORM self-sync to own devices');
  await delay(300);

  // --- Test 4: Receiver can query ---
  // Wait for bob's CRDT to process
  await delay(500);
  const bobStories = await bob.story.where({ authorDeviceId: alice.deviceUUID }).exec();
  if (bobStories.length !== 2) throw new Error(`Query failed: expected 2 (Hello ORM + Self-sync), got ${bobStories.length}`);
  ok('Receiver can query synced data');
  await delay(300);

  // --- Test 4b: Reverse direction (bob → alice) ---
  const aliceSyncPromise = once(alice, 'modelSync');
  const alice3SyncPromise2 = once(alice3, 'modelSync');
  const bobStory = await bob.story.create({ content: 'From bob!' });
  const [aliceReceived, alice3Received2] = await Promise.all([aliceSyncPromise, alice3SyncPromise2]);
  if (aliceReceived.id !== bobStory.id) throw new Error('alice didnt receive bob story');
  if (alice3Received2.id !== bobStory.id) throw new Error('alice3 didnt receive bob story');
  ok('Reverse ORM sync (bob → alice + alice3)');
  await delay(300);

  // --- Test 4c: Alice can query bob's data (bidirectional) ---
  await delay(500);  // Wait for CRDT to process
  const aliceQueryBob = await alice.story.where({ authorDeviceId: bob.deviceUUID }).exec();
  if (aliceQueryBob.length !== 1) throw new Error(`Alice query bob failed: expected 1, got ${aliceQueryBob.length}`);
  if (aliceQueryBob[0].data.content !== 'From bob!') throw new Error('Alice query bob data wrong');
  ok('Bidirectional query (alice queries bob data)');
  await delay(300);

  // --- Test 5: Field validation ---
  try {
    await alice.story.create({ content: 123 });  // content should be string
    throw new Error('Should reject bad type');
  } catch (e) {
    if (!e.message.includes('Validation')) throw e;
  }
  ok('Field validation rejects bad types');
  await delay(300);

  // --- Test 6: Multiple models (generic machinery) ---
  const streak = await alice.streak.create({ count: 1, lastActivity: Date.now() });
  if (!streak.id.startsWith('streak_')) throw new Error('Streak ID wrong');
  const localStreak = await alice.streak.find(streak.id);
  if (!localStreak) throw new Error('Streak not persisted');
  if (localStreak.data.count !== 1) throw new Error('Streak data wrong');
  ok('Multiple models work (generic machinery)');
  await delay(300);

  // --- Test 7: LWW upsert ---
  const streakId = `streak_bob_${ts}`;
  await alice.streak.upsert(streakId, { count: 5, lastActivity: Date.now() });
  const s1 = await alice.streak.find(streakId);
  if (s1.data.count !== 5) throw new Error('Upsert failed');

  // Update with newer timestamp should win
  await delay(10);  // Ensure newer timestamp
  await alice.streak.upsert(streakId, { count: 10, lastActivity: Date.now() });
  const s2 = await alice.streak.find(streakId);
  if (s2.data.count !== 10) throw new Error('LWW update failed');
  ok('LWW upsert works');
  await delay(300);

  // --- Test 8: Query operators ---
  // Create more streaks with varying counts for query testing
  await alice.streak.upsert(`streak_a_${ts}`, { count: 3, lastActivity: Date.now() });
  await alice.streak.upsert(`streak_b_${ts}`, { count: 7, lastActivity: Date.now() });
  await alice.streak.upsert(`streak_c_${ts}`, { count: 15, lastActivity: Date.now() });
  await delay(300);

  // Test gt (greater than)
  const gtResult = await alice.streak.where({ 'data.count': { gt: 5 } }).exec();
  if (gtResult.length !== 3) throw new Error(`gt query: expected 3 (7, 10, 15), got ${gtResult.length}`);
  ok('Query operator: gt');

  // Test lt (less than)
  const ltResult = await alice.streak.where({ 'data.count': { lt: 5 } }).exec();
  if (ltResult.length !== 2) throw new Error(`lt query: expected 2 (1, 3), got ${ltResult.length}`);
  ok('Query operator: lt');

  // Test gte/lte combined (range)
  const rangeResult = await alice.streak.where({ 'data.count': { gte: 5, lte: 10 } }).exec();
  if (rangeResult.length !== 2) throw new Error(`range query: expected 2 (5→10, 7), got ${rangeResult.length}`);
  ok('Query operator: range (gte/lte)');

  // Test in (set membership)
  const inResult = await alice.streak.where({ 'data.count': { in: [1, 7, 15] } }).exec();
  if (inResult.length !== 3) throw new Error(`in query: expected 3, got ${inResult.length}`);
  ok('Query operator: in');

  // Test orderBy + limit
  const orderedResult = await alice.streak.where({}).orderBy('data.count', 'desc').limit(2).exec();
  if (orderedResult.length !== 2) throw new Error(`orderBy+limit: expected 2, got ${orderedResult.length}`);
  if (orderedResult[0].data.count !== 15) throw new Error(`orderBy desc: expected 15 first, got ${orderedResult[0].data.count}`);
  ok('Query: orderBy + limit');

  // Test first()
  const firstResult = await alice.streak.where({ 'data.count': { gt: 10 } }).first();
  if (!firstResult || firstResult.data.count !== 15) throw new Error('first() failed');
  ok('Query: first()');

  // Test count()
  const countResult = await alice.streak.where({}).count();
  if (countResult !== 5) throw new Error(`count: expected 5 streaks, got ${countResult}`);
  ok('Query: count()');

  // Test contains (string operator)
  const containsResult = await alice.story.where({ 'data.content': { contains: 'bob' } }).exec();
  if (containsResult.length !== 1) throw new Error(`contains: expected 1 (From bob!), got ${containsResult.length}`);
  ok('Query operator: contains');
  await delay(300);

  // ==========================================================================
  // ASSOCIATIONS + NEW MODELS
  // ==========================================================================

  // --- Test 9: Comment on story (belongs_to association) ---
  const storyForComments = await alice.story.create({ content: 'Comment me!' });
  const comment1 = await bob.comment.create({ storyId: storyForComments.id, text: 'Nice story!' });
  if (!comment1.id.startsWith('comment_')) throw new Error('Comment ID wrong');
  if (comment1.data.storyId !== storyForComments.id) throw new Error('Comment storyId not set');
  ok('Comment on story (belongs_to)');
  await delay(500);

  // --- Test 10: Reply to comment (nested belongs_to) ---
  const reply = await alice.comment.create({ commentId: comment1.id, text: 'Thanks for the feedback!' });
  if (!reply.id.startsWith('comment_')) throw new Error('Reply ID wrong');
  if (reply.data.commentId !== comment1.id) throw new Error('Reply commentId not set');
  ok('Reply to comment (nested belongs_to)');
  await delay(500);

  // --- Test 11: Query with include() ---
  const storiesWithComments = await alice.story.where({ id: storyForComments.id }).include('comment').exec();
  if (storiesWithComments.length !== 1) throw new Error('Story query failed');
  if (!storiesWithComments[0].comments) throw new Error('Comments not loaded');
  if (storiesWithComments[0].comments.length !== 1) throw new Error(`Expected 1 comment, got ${storiesWithComments[0].comments.length}`);
  if (storiesWithComments[0].comments[0].data.text !== 'Nice story!') throw new Error('Comment content wrong');
  ok('Query with include(comment)');
  await delay(300);

  // --- Test 12: Reaction on story (LWW) ---
  const reaction1 = await bob.reaction.create({ storyId: storyForComments.id, emoji: '❤️' });
  if (!reaction1.id.startsWith('reaction_')) throw new Error('Reaction ID wrong');
  ok('Reaction on story (LWW)');
  await delay(500);

  // --- Test 13: Reaction update (LWW upsert) ---
  await delay(10);  // Ensure newer timestamp
  await bob.reaction.upsert(reaction1.id, { storyId: storyForComments.id, emoji: '🔥' });
  const updatedReaction = await bob.reaction.find(reaction1.id);
  if (updatedReaction.data.emoji !== '🔥') throw new Error(`Reaction not updated: ${updatedReaction.data.emoji}`);
  ok('Reaction update (LWW upsert)');
  await delay(300);

  // --- Test 14: Query with include(reaction) ---
  await delay(500);  // Wait for sync
  const storiesWithReactions = await alice.story.where({ id: storyForComments.id }).include('reaction').exec();
  if (!storiesWithReactions[0].reactions) throw new Error('Reactions not loaded');
  if (storiesWithReactions[0].reactions.length !== 1) throw new Error(`Expected 1 reaction, got ${storiesWithReactions[0].reactions.length}`);
  ok('Query with include(reaction)');
  await delay(300);

  // --- Test 14b: Batch loadInto ---
  const batchStory = await alice.story.create({ content: 'Batch test' });
  await bob.comment.create({ storyId: batchStory.id, text: 'Comment 1' });
  await bob.comment.create({ storyId: batchStory.id, text: 'Comment 2' });
  await delay(500);

  const allStories = await alice.story.where({}).exec();
  await alice.comment.loadInto(allStories, 'storyId');

  const loadedStory = allStories.find(s => s.id === batchStory.id);
  if (!loadedStory.comments || loadedStory.comments.length !== 2) {
    throw new Error(`loadInto failed: expected 2 comments, got ${loadedStory.comments?.length}`);
  }
  ok('Batch loadInto works');
  await delay(300);

  // --- Test 15: Profile (collectable model) ---
  const alice3ProfilePromise = once(alice3, 'modelSync');
  const bobProfilePromise = once(bob, 'modelSync');
  const profile = await alice.profile.create({ displayName: 'Alice', bio: 'Hello world!' });
  if (!profile.id.startsWith('profile_')) throw new Error('Profile ID wrong');

  // Should sync to both alice3 (self-sync) and bob (friend sync)
  const [alice3Profile, bobProfile] = await Promise.all([alice3ProfilePromise, bobProfilePromise]);
  if (alice3Profile.model !== 'profile') throw new Error('Profile self-sync failed');
  if (bobProfile.model !== 'profile') throw new Error('Profile friend sync failed');
  ok('Profile create + sync (collectable)');
  await delay(300);

  // --- Test 16: Private model (settings) - no friend sync ---
  // Settings should ONLY sync to own devices, NOT friends
  let bobReceivedSettings = false;
  const bobSettingsHandler = (data) => {
    if (data.model === 'settings') bobReceivedSettings = true;
  };
  bob.on('modelSync', bobSettingsHandler);

  const alice3SettingsPromise = once(alice3, 'modelSync');
  const settings = await alice.settings.create({ theme: 'dark', notificationsEnabled: true });
  if (!settings.id.startsWith('settings_')) throw new Error('Settings ID wrong');

  // alice3 should receive
  const alice3Settings = await alice3SettingsPromise;
  if (alice3Settings.model !== 'settings') throw new Error('Settings self-sync failed');
  ok('Private model self-sync to own devices');
  await delay(500);

  // bob should NOT have received it
  bob.off('modelSync', bobSettingsHandler);
  if (bobReceivedSettings) throw new Error('Private model leaked to friend!');
  ok('Private model: settings not sent to friends');
  await delay(300);

  // --- Test 17: Deletion (LWW tombstone) ---
  const tempReaction = await alice.reaction.create({ storyId: storyForComments.id, emoji: '👋' });
  await delay(300);

  // Delete the reaction
  await alice.reaction.delete(tempReaction.id);
  await delay(300);

  // Verify it's marked as deleted
  const deleted = await alice.reaction.find(tempReaction.id);
  if (!deleted || !deleted.data._deleted) throw new Error('Deletion failed - tombstone not set');
  ok('Deletion (LWW tombstone)');
  await delay(300);

  // ==========================================================================
  // GROUP TARGETING TESTS
  // ==========================================================================

  // --- Test 18: Create a third user (carol) for group targeting test ---
  const carol = await Obscura.register(`carol_${ts}`, 'pass', { apiUrl: API });
  await carol.connect();
  await delay(300);

  // Make alice and carol friends
  const carolReqPromise = once(carol, 'friendRequest');
  const aliceCarolRespPromise = once(alice, 'friendResponse');
  await alice.befriend(carol.userId, carol.username);
  const carolReq = await carolReqPromise;
  await carolReq.accept();
  await aliceCarolRespPromise;
  await delay(300);

  // Carol needs the schema too
  await carol.schema(fullSchema);
  ok('Carol registered and friended');
  await delay(300);

  // --- Test 19: Create group with alice and bob (NOT carol) ---
  const group = await alice.group.create({
    name: 'Test Group',
    members: JSON.stringify([alice.username, bob.username]),  // alice + bob, NOT carol
  });
  if (!group.id.startsWith('group_')) throw new Error('Group ID wrong');
  ok('Group create with members');
  await delay(500);

  // --- Test 20: Group message only goes to members ---
  // bob should receive (he's a member)
  const bobGroupMsgPromise = once(bob, 'modelSync');

  // bob2 should ALSO receive (bob2 is bob's device, bob is a member)
  const bob2GroupMsgPromise = once(bob2, 'modelSync');

  // carol should NOT receive (not in members list)
  let carolReceivedGroupMsg = false;
  const carolGroupHandler = (data) => {
    if (data.model === 'groupMessage') carolReceivedGroupMsg = true;
  };
  carol.on('modelSync', carolGroupHandler);

  // alice3 should receive (self-sync)
  const alice3GroupMsgPromise = once(alice3, 'modelSync');

  // Send group message
  const groupMsg = await alice.groupMessage.create({ groupId: group.id, text: 'Hello group!' });
  if (!groupMsg.id.startsWith('groupMessage_')) throw new Error('GroupMessage ID wrong');

  // Verify bob received
  const bobGroupMsg = await bobGroupMsgPromise;
  if (bobGroupMsg.model !== 'groupMessage') throw new Error('bob should receive groupMessage');
  ok('Group member (bob) receives message');

  // Verify bob2 also received (same user, different device)
  const bob2GroupMsg = await bob2GroupMsgPromise;
  if (bob2GroupMsg.model !== 'groupMessage') throw new Error('bob2 should also receive (bob is member)');
  ok('Group member multi-device (bob2) receives message');

  // Verify alice3 received (self-sync still works)
  const alice3GroupMsg = await alice3GroupMsgPromise;
  if (alice3GroupMsg.model !== 'groupMessage') throw new Error('alice3 should receive via self-sync');
  ok('Group creator self-sync works');

  // Verify carol did NOT receive
  await delay(500);
  carol.off('modelSync', carolGroupHandler);
  if (carolReceivedGroupMsg) throw new Error('carol should NOT receive (not in group members)');
  ok('Non-member (carol) does NOT receive');
  await delay(300);

  // Cleanup carol
  carol.disconnect();

  console.log('\n  --- ORM Layer Complete ---');

  // --- Cleanup ---
  [alice, alice3, bob, bob2].forEach(c => c.disconnect());

  console.log(`\n${'='.repeat(50)}`);
  console.log('  ALL TESTS PASSED!');
  console.log(`${'='.repeat(50)}\n`);
}

main().catch(e => {
  console.error('\nFATAL:', e.message);
  console.error(e.stack);
  process.exit(1);
});
