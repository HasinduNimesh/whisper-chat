/**
 * Integration tests for the multi-tenant data layer. They run only when a
 * database is provided (TEST_DATABASE_URL → mapped to DATABASE_URL by
 * vitest.config.ts); otherwise the whole suite is skipped.
 *
 * The heart of this suite is TENANT ISOLATION: every repo call scoped to
 * org A must be blind to org B's rows.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { initDb } from './migrate.js';
import { closePool, getPool } from './pool.js';
import { createOrg, getOrgById, updateOrgEncryptionMode, type Org } from './orgs.js';
import {
  createUser,
  disableUser,
  getUserById,
  getUserForLogin,
  listUsers,
  setUserPublicKey,
  type OrgUser,
} from './users.js';
import {
  createSession,
  deleteSession,
  deleteSessionsForUser,
  getSessionUser,
} from './sessions.js';
import { consumeInvite, createInvite, getUsableInvite } from './invites.js';
import { createApiKey, getApiKeyForVerify, listApiKeys, revokeApiKey } from './apiKeys.js';
import { createVisitor, getVisitorBySecretHash } from './visitors.js';
import {
  addParticipant,
  assignConversation,
  createConversation,
  getConversation,
  getConversationByExternalKey,
  getOpenConversationForVisitor,
  listConversations,
  listParticipants,
  setConversationStatus,
  touchConversation,
} from './conversations.js';
import {
  insertE2eMessage,
  insertManagedMessage,
  listE2eMessages,
  listManagedMessages,
} from './convMessages.js';

const HAS_DB = Boolean(process.env.DATABASE_URL);
const FUTURE = () => new Date(Date.now() + 60 * 60 * 1000);
const PAST = () => new Date(Date.now() - 60 * 1000);

// Unique suffix so repeated local runs never collide on unique columns.
const run = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

describe.skipIf(!HAS_DB)('tenancy data layer (integration)', () => {
  let orgA: Org;
  let orgB: Org;
  let adminA: OrgUser;
  let agentB: OrgUser;

  beforeAll(async () => {
    await initDb();
    orgA = (await createOrg({ name: 'Org A', slug: `org-a-${run}`, encryptionMode: 'managed' }))!;
    orgB = (await createOrg({ name: 'Org B', slug: `org-b-${run}`, encryptionMode: 'e2e' }))!;
    adminA = (await createUser(orgA.id, {
      email: `admin-a-${run}@test.example`,
      passwordHash: 'x',
      displayName: 'Admin A',
      role: 'admin',
    }))!;
    agentB = (await createUser(orgB.id, {
      email: `agent-b-${run}@test.example`,
      passwordHash: 'y',
      displayName: 'Agent B',
      role: 'agent',
    }))!;
  });

  afterAll(async () => {
    await closePool();
  });

  it('migrations are idempotent and recorded', async () => {
    await initDb(); // second run must be a clean no-op
    const res = await getPool()!.query('SELECT id FROM schema_migrations ORDER BY id');
    expect(res.rows.map((r) => Number(r.id))).toEqual([1, 2]);
  });

  it('org slugs are unique (conflict returns null, no throw)', async () => {
    const dup = await createOrg({ name: 'Dup', slug: orgA.slug, encryptionMode: 'e2e' });
    expect(dup).toBeNull();
  });

  it('emails are globally unique across orgs', async () => {
    const dup = await createUser(orgB.id, {
      email: adminA.email,
      passwordHash: 'z',
      displayName: 'Impostor',
      role: 'admin',
    });
    expect(dup).toBeNull();
  });

  it('getUserById is org-scoped: org B cannot resolve org A staff', async () => {
    expect(await getUserById(orgA.id, adminA.id)).not.toBeNull();
    expect(await getUserById(orgB.id, adminA.id)).toBeNull();
  });

  it('listUsers only sees its own org', async () => {
    const usersA = await listUsers(orgA.id);
    expect(usersA.some((u) => u.id === adminA.id)).toBe(true);
    expect(usersA.some((u) => u.id === agentB.id)).toBe(false);
  });

  it('login lookup returns the hash; sessions resolve, slide, and expire', async () => {
    const login = await getUserForLogin(adminA.email);
    expect(login?.passwordHash).toBe('x');

    const hash = `session-${run}`;
    await createSession(hash, adminA.id, FUTURE(), { ip: '127.0.0.1' });
    const resolved = await getSessionUser(hash, FUTURE());
    expect(resolved?.userId).toBe(adminA.id);
    expect(resolved?.orgId).toBe(orgA.id);
    expect(resolved?.role).toBe('admin');

    // Slide the expiry into the past → next lookup must fail.
    await getSessionUser(hash, PAST());
    expect(await getSessionUser(hash, FUTURE())).toBeNull();
    await deleteSession(hash);
  });

  it('sessions of disabled users stop resolving', async () => {
    const victim = (await createUser(orgA.id, {
      email: `victim-${run}@test.example`,
      passwordHash: 'v',
      displayName: 'Victim',
      role: 'agent',
    }))!;
    const hash = `victim-session-${run}`;
    await createSession(hash, victim.id, FUTURE());
    expect(await getSessionUser(hash, FUTURE())).not.toBeNull();

    expect(await disableUser(orgA.id, victim.id)).toBe(true);
    expect(await getSessionUser(hash, FUTURE())).toBeNull();
    await deleteSessionsForUser(victim.id);
  });

  it('disableUser is org-scoped', async () => {
    expect(await disableUser(orgB.id, adminA.id)).toBe(false);
  });

  it('setUserPublicKey is org-scoped', async () => {
    await setUserPublicKey(orgB.id, adminA.id, 'SHOULD_NOT_LAND'); // wrong org → no-op
    expect((await getUserById(orgA.id, adminA.id))?.publicKey).toBeNull();

    await setUserPublicKey(orgA.id, adminA.id, 'AGENT_PUBKEY');
    expect((await getUserById(orgA.id, adminA.id))?.publicKey).toBe('AGENT_PUBKEY');
  });

  it('invites are single-use and expire', async () => {
    const hash = `invite-${run}`;
    await createInvite(orgA.id, {
      tokenHash: hash,
      role: 'agent',
      createdBy: adminA.id,
      expiresAt: FUTURE(),
    });
    const invite = await getUsableInvite(hash);
    expect(invite?.orgId).toBe(orgA.id);
    expect(invite?.orgName).toBe('Org A');

    expect(await consumeInvite(hash, adminA.id)).toBe(true);
    expect(await consumeInvite(hash, adminA.id)).toBe(false); // second accept loses
    expect(await getUsableInvite(hash)).toBeNull();

    const expired = `invite-expired-${run}`;
    await createInvite(orgA.id, {
      tokenHash: expired,
      role: 'agent',
      createdBy: adminA.id,
      expiresAt: PAST(),
    });
    expect(await getUsableInvite(expired)).toBeNull();
    expect(await consumeInvite(expired, adminA.id)).toBe(false);
  });

  it('api keys: list never exposes the secret; verify honors revocation', async () => {
    const kid = `kid-${run}`;
    await createApiKey(orgA.id, { kid, secret: 'topsecret', label: 'store backend' });

    const listed = await listApiKeys(orgA.id);
    const mine = listed.find((k) => k.kid === kid)!;
    expect(mine).toBeDefined();
    expect('secret' in mine).toBe(false);

    const verify = await getApiKeyForVerify(kid);
    expect(verify?.orgId).toBe(orgA.id);
    expect(verify?.secret).toBe('topsecret');
    expect(verify?.revokedAt).toBeNull();

    // Revocation is org-scoped, then takes effect for verification.
    expect(await revokeApiKey(orgB.id, mine.id)).toBe(false);
    expect(await revokeApiKey(orgA.id, mine.id)).toBe(true);
    expect((await getApiKeyForVerify(kid))?.revokedAt).not.toBeNull();
  });

  it('visitors are per-org: same secret hash in two orgs = two identities', async () => {
    const secretHash = `visitor-hash-${run}`;
    const vA = await createVisitor(orgA.id, secretHash, 'Visitor');
    const vB = await createVisitor(orgB.id, secretHash, 'Visitor');
    expect(vA.id).not.toBe(vB.id);

    expect((await getVisitorBySecretHash(orgA.id, secretHash))?.id).toBe(vA.id);
    expect(await getVisitorBySecretHash(orgA.id, `missing-${run}`)).toBeNull();

    // createVisitor is an idempotent upsert.
    const again = await createVisitor(orgA.id, secretHash, 'Visitor');
    expect(again.id).toBe(vA.id);
  });

  it('conversations: external keys are per-org unique, cross-org reads are blind', async () => {
    const externalKey = `listing:99:buyer:42:seller:7`;
    const convA = await createConversation(orgA.id, {
      kind: 'c2c',
      encryption: 'managed',
      externalKey,
      context: { listingId: '99' },
    });
    // Same external key in org B is a *different* conversation — no bleed.
    const convB = await createConversation(orgB.id, {
      kind: 'c2c',
      encryption: 'e2e',
      externalKey,
    });
    expect(convA.id).not.toBe(convB.id);

    expect((await getConversationByExternalKey(orgA.id, externalKey))?.id).toBe(convA.id);
    expect((await getConversationByExternalKey(orgB.id, externalKey))?.id).toBe(convB.id);

    // The isolation core: org B cannot see org A's conversation by id.
    expect(await getConversation(orgB.id, convA.id)).toBeNull();
    expect(await getConversation(orgA.id, convA.id)).not.toBeNull();
  });

  it('encryption mode locks once an org has conversations', async () => {
    // orgA got a conversation in the previous test → mode is frozen.
    expect(await updateOrgEncryptionMode(orgA.id, 'e2e')).toBe(false);
    expect((await getOrgById(orgA.id))?.encryptionMode).toBe('managed');

    const fresh = (await createOrg({
      name: 'Fresh',
      slug: `fresh-${run}`,
      encryptionMode: 'e2e',
    }))!;
    expect(await updateOrgEncryptionMode(fresh.id, 'managed')).toBe(true);
  });

  it('participants: idempotent joins, org-scoped listing', async () => {
    const conv = await createConversation(orgA.id, { kind: 'b2c', encryption: 'managed' });
    const p1 = await addParticipant(orgA.id, conv.id, {
      kind: 'agent',
      agentId: adminA.id,
      displayName: 'Admin A',
    });
    const p1again = await addParticipant(orgA.id, conv.id, {
      kind: 'agent',
      agentId: adminA.id,
      displayName: 'Admin A (renamed)',
    });
    expect(p1again.id).toBe(p1.id); // converges on the same row
    expect(p1again.displayName).toBe('Admin A (renamed)');

    const visitor = await createVisitor(orgA.id, `conv-visitor-${run}`, 'Shopper');
    await addParticipant(orgA.id, conv.id, {
      kind: 'visitor',
      visitorId: visitor.id,
      displayName: 'Shopper',
    });

    const parts = await listParticipants(orgA.id, conv.id);
    expect(parts).toHaveLength(2);
    expect(await listParticipants(orgB.id, conv.id)).toHaveLength(0); // isolation

    expect((await getOpenConversationForVisitor(orgA.id, visitor.id))?.id).toBe(conv.id);
    expect(await getOpenConversationForVisitor(orgB.id, visitor.id)).toBeNull();
  });

  it('inbox listing filters status/assignment and stays in-org', async () => {
    const conv = await createConversation(orgA.id, { kind: 'b2c', encryption: 'managed' });
    await touchConversation(orgA.id, conv.id);

    const unassigned = await listConversations(orgA.id, { status: 'open', unassigned: true });
    expect(unassigned.some((c) => c.id === conv.id)).toBe(true);
    expect(unassigned.every((c) => c.orgId === orgA.id)).toBe(true);

    expect(await assignConversation(orgA.id, conv.id, adminA.id)).toBe(true);
    const mine = await listConversations(orgA.id, { assignedAgentId: adminA.id });
    expect(mine.some((c) => c.id === conv.id)).toBe(true);

    expect(await setConversationStatus(orgA.id, conv.id, 'closed')).toBe(true);
    const openNow = await listConversations(orgA.id, { status: 'open' });
    expect(openNow.some((c) => c.id === conv.id)).toBe(false);

    // Cross-org writes must not land.
    expect(await assignConversation(orgB.id, conv.id, agentB.id)).toBe(false);
    expect(await setConversationStatus(orgB.id, conv.id, 'open')).toBe(false);
  });

  it('managed messages: insert/list, org-scoped', async () => {
    const conv = await createConversation(orgA.id, { kind: 'b2c', encryption: 'managed' });
    const agent = await addParticipant(orgA.id, conv.id, {
      kind: 'agent',
      agentId: adminA.id,
      displayName: 'Admin A',
    });
    await insertManagedMessage(orgA.id, {
      conversationId: conv.id,
      senderParticipantId: agent.id,
      body: 'hello from the org',
      sentAt: Date.now(),
    });

    const msgs = await listManagedMessages(orgA.id, conv.id);
    expect(msgs).toHaveLength(1);
    expect(msgs[0].body).toBe('hello from the org');

    // Org B sees nothing, even with the right conversation id.
    expect(await listManagedMessages(orgB.id, conv.id)).toHaveLength(0);
  });

  it('e2e messages: per-recipient rows, org-scoped', async () => {
    const conv = await createConversation(orgB.id, { kind: 'c2c', encryption: 'e2e' });
    await insertE2eMessage(orgB.id, {
      conversationId: conv.id,
      recipientPublicKey: 'RECIPIENT_KEY',
      senderPublicKey: 'SENDER_KEY',
      senderDisplayName: 'Seller',
      ciphertext: 'b64-ciphertext',
      nonce: 'b64-nonce',
      sentAt: Date.now(),
    });

    const forRecipient = await listE2eMessages(orgB.id, conv.id, 'RECIPIENT_KEY');
    expect(forRecipient).toHaveLength(1);
    expect(forRecipient[0].ciphertext).toBe('b64-ciphertext');

    expect(await listE2eMessages(orgB.id, conv.id, 'OTHER_KEY')).toHaveLength(0);
    expect(await listE2eMessages(orgA.id, conv.id, 'RECIPIENT_KEY')).toHaveLength(0);
  });

  it('legacy tables coexist untouched (migration 001)', async () => {
    const res = await getPool()!.query(
      `SELECT table_name FROM information_schema.tables
       WHERE table_name IN ('room_members', 'messages', 'handles')`,
    );
    expect(res.rows).toHaveLength(3);
  });
});
