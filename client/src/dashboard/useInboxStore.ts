/**
 * Dashboard state: session, inbox, the one open conversation (REST +
 * WebSocket), and admin settings. Deliberately separate from the private
 * chat's useChatStore — different world, different lifecycle.
 *
 * E2E-mode orgs: sealing/opening happens here, client-side, using the
 * agent's local identity — message plaintext never reaches the server,
 * matching the invariant in shared/src/index.ts.
 */
import { create } from 'zustand';
import type {
  ConversationPeer,
  HistoryEntry,
  ServerMessage,
  ChatPayload,
} from '@private-chat/shared';
import { SignalingClient, signalingUrl } from '../signaling/client';
import { fromB64, openFrom, sealTo, toB64, type Identity } from '../crypto/index';
import { ensureAgentIdentity } from './agentIdentity';
import {
  api,
  ApiError,
  type ApiKeyDto,
  type ConversationDto,
  type OrgDto,
  type UserDto,
} from './api';

export interface InboxMessage {
  id: string;
  participantId: string;
  fromName: string;
  fromKind: 'agent' | 'visitor' | 'external';
  mine: boolean;
  text: string;
  sentAt: number;
}

export type InboxFilter = 'unassigned' | 'mine' | 'open' | 'closed';

interface ActiveConversation {
  id: string;
  detail: ConversationDto;
  selfParticipantId: string | null;
  participants: ConversationPeer[];
  messages: InboxMessage[];
  connected: boolean;
  error: string | null;
}

interface InboxState {
  status: 'loading' | 'anon' | 'authed';
  user: UserDto | null;
  org: OrgDto | null;
  identity: Identity | null; // e2e orgs only
  authError: string | null;

  conversations: ConversationDto[];
  filter: InboxFilter;
  inboxLoading: boolean;

  active: ActiveConversation | null;

  agents: UserDto[];
  apiKeys: ApiKeyDto[];

  loadMe: () => Promise<void>;
  login: (email: string, password: string) => Promise<boolean>;
  register: (input: {
    orgName: string;
    slug: string;
    encryptionMode: 'e2e' | 'managed';
    email: string;
    password: string;
    displayName: string;
  }) => Promise<boolean>;
  acceptInvite: (input: {
    token: string;
    email: string;
    password: string;
    displayName: string;
  }) => Promise<boolean>;
  logout: () => Promise<void>;

  setFilter: (f: InboxFilter) => void;
  loadConversations: () => Promise<void>;
  openConversation: (id: string) => Promise<void>;
  closeActive: () => void;
  sendMessage: (text: string) => void;
  assignToMe: () => Promise<void>;
  setConversationStatus: (status: 'open' | 'closed') => Promise<void>;

  loadAgents: () => Promise<void>;
  disableAgent: (id: string) => Promise<void>;
  loadApiKeys: () => Promise<void>;
}

let conversationClient: SignalingClient | null = null;
let inboxClient: SignalingClient | null = null;
let inboxReloadTimer: ReturnType<typeof setTimeout> | undefined;

export const useInboxStore = create<InboxState>((set, get) => {
  async function onSignedIn(user: UserDto, org: OrgDto): Promise<void> {
    let identity: Identity | null = null;
    if (org.encryptionMode === 'e2e') {
      identity = await ensureAgentIdentity(user.id, user.publicKey);
    }
    set({ status: 'authed', user, org, identity, authError: null });
    startInboxSocket();
    void get().loadConversations();
  }

  function startInboxSocket(): void {
    inboxClient?.close();
    inboxClient = new SignalingClient(signalingUrl(), {
      onMessage: (msg: ServerMessage) => {
        if (msg.type === 'inbox-event') {
          // A hint, not a payload: refetch the list (debounced).
          if (inboxReloadTimer) clearTimeout(inboxReloadTimer);
          inboxReloadTimer = setTimeout(() => void get().loadConversations(), 400);
        }
      },
    });
    inboxClient.connect();
    inboxClient.send({ type: 'join-inbox' });
  }

  function appendMessage(m: InboxMessage): void {
    const active = get().active;
    if (!active) return;
    if (active.messages.some((x) => x.id === m.id)) return; // echo dedupe
    set({ active: { ...active, messages: [...active.messages, m] } });
  }

  function decryptEntry(entry: HistoryEntry, identity: Identity, selfB64: string): InboxMessage | null {
    try {
      const plaintext = openFrom(
        { ciphertext: entry.ciphertext, nonce: entry.nonce },
        fromB64(entry.fromPublicKey),
        identity.privateKey,
      );
      const payload = JSON.parse(plaintext) as ChatPayload;
      if (payload.kind !== 'text' || typeof payload.text !== 'string') return null;
      return {
        id: `${entry.fromPublicKey}:${entry.nonce}`,
        participantId: entry.fromPublicKey,
        fromName: entry.fromDisplayName,
        fromKind: 'external',
        mine: entry.fromPublicKey === selfB64,
        text: payload.text,
        sentAt: payload.sentAt ?? entry.sentAt,
      };
    } catch {
      return null; // fail closed: drop undecryptable frames silently
    }
  }

  function handleConversationMessage(msg: ServerMessage): void {
    const { active, identity, user } = get();
    if (!active) return;

    if (msg.type === 'conversation-joined') {
      const selfB64 = identity ? toB64(identity.publicKey) : '';
      const history: InboxMessage[] = [];
      for (const h of msg.history ?? []) {
        history.push({
          id: h.id,
          participantId: h.from.participantId,
          fromName: h.from.displayName,
          fromKind: h.from.kind,
          mine: h.from.participantId === msg.selfParticipantId,
          text: h.text,
          sentAt: h.sentAt,
        });
      }
      if (identity) {
        for (const entry of msg.e2eHistory ?? []) {
          const m = decryptEntry(entry, identity, selfB64);
          if (m) history.push(m);
        }
      }
      set({
        active: {
          ...active,
          selfParticipantId: msg.selfParticipantId,
          participants: msg.participants,
          messages: history,
          connected: true,
          error: null,
        },
      });
      return;
    }

    if (msg.type === 'message') {
      appendMessage({
        id: msg.id,
        participantId: msg.from.participantId,
        fromName: msg.from.displayName,
        fromKind: msg.from.kind,
        mine: msg.from.participantId === get().active?.selfParticipantId,
        text: msg.text,
        sentAt: msg.sentAt,
      });
      return;
    }

    if (msg.type === 'deliver' && identity) {
      const selfB64 = toB64(identity.publicKey);
      const sender = get().active?.participants.find((p) => p.publicKey === msg.from);
      const m = decryptEntry(
        { fromPublicKey: msg.from, fromDisplayName: sender?.displayName ?? 'Peer', ciphertext: msg.ciphertext, nonce: msg.nonce, sentAt: Date.now() },
        identity,
        selfB64,
      );
      if (m) appendMessage(m);
      return;
    }

    if (msg.type === 'conversation-peer') {
      const current = get().active;
      if (!current) return;
      const rest = current.participants.filter((p) => p.participantId !== msg.peer.participantId);
      set({ active: { ...current, participants: [...rest, msg.peer] } });
      return;
    }

    if (msg.type === 'error') {
      const current = get().active;
      if (current) set({ active: { ...current, error: msg.message } });
      // Session-scoped errors also matter globally.
      if (msg.code === 'unauthorized' && !user) set({ status: 'anon' });
    }
  }

  return {
    status: 'loading',
    user: null,
    org: null,
    identity: null,
    authError: null,
    conversations: [],
    filter: 'open',
    inboxLoading: false,
    active: null,
    agents: [],
    apiKeys: [],

    async loadMe() {
      try {
        const { user, org } = await api<{ user: UserDto; org: OrgDto }>('GET', '/api/auth/me');
        await onSignedIn(user, org);
      } catch {
        set({ status: 'anon' });
      }
    },

    async login(email, password) {
      try {
        const { user, org } = await api<{ user: UserDto; org: OrgDto }>('POST', '/api/auth/login', {
          email,
          password,
        });
        await onSignedIn(user, org);
        return true;
      } catch (err) {
        set({ authError: err instanceof ApiError ? err.message : 'Login failed', status: 'anon' });
        return false;
      }
    },

    async register(input) {
      try {
        const { user, org } = await api<{ user: UserDto; org: OrgDto }>('POST', '/api/orgs', input);
        await onSignedIn(user, org);
        return true;
      } catch (err) {
        set({ authError: err instanceof ApiError ? err.message : 'Registration failed' });
        return false;
      }
    },

    async acceptInvite(input) {
      try {
        const { user, org } = await api<{ user: UserDto; org: OrgDto }>(
          'POST',
          '/api/invites/accept',
          input,
        );
        await onSignedIn(user, org);
        return true;
      } catch (err) {
        set({ authError: err instanceof ApiError ? err.message : 'Could not accept the invite' });
        return false;
      }
    },

    async logout() {
      get().closeActive();
      inboxClient?.close();
      inboxClient = null;
      await api('POST', '/api/auth/logout').catch(() => {});
      set({ status: 'anon', user: null, org: null, identity: null, conversations: [] });
    },

    setFilter(filter) {
      set({ filter });
      void get().loadConversations();
    },

    async loadConversations() {
      const { filter } = get();
      const params =
        filter === 'unassigned'
          ? '?status=open&assigned=unassigned'
          : filter === 'mine'
            ? '?status=open&assigned=me'
            : `?status=${filter}`;
      set({ inboxLoading: true });
      try {
        const { conversations } = await api<{ conversations: ConversationDto[] }>(
          'GET',
          `/api/conversations${params}`,
        );
        set({ conversations, inboxLoading: false });
      } catch {
        set({ inboxLoading: false });
      }
    },

    async openConversation(id) {
      get().closeActive();
      const { identity } = get();
      const { conversation } = await api<{ conversation: ConversationDto }>(
        'GET',
        `/api/conversations/${id}`,
      );
      set({
        active: {
          id,
          detail: conversation,
          selfParticipantId: null,
          participants: [],
          messages: [],
          connected: false,
          error: null,
        },
      });

      conversationClient = new SignalingClient(signalingUrl(), {
        onMessage: handleConversationMessage,
        onClose: () => {
          const active = get().active;
          if (active && active.id === id) set({ active: { ...active, connected: false } });
        },
      });
      conversationClient.connect();
      conversationClient.send({
        type: 'join-conversation',
        conversationId: id,
        auth: { kind: 'session' },
        ...(identity ? { publicKey: toB64(identity.publicKey) } : {}),
      });
    },

    closeActive() {
      conversationClient?.close();
      conversationClient = null;
      set({ active: null });
    },

    sendMessage(text) {
      const { active, identity, user } = get();
      const trimmed = text.trim();
      if (!active || !conversationClient || !trimmed) return;

      if (active.detail.encryption === 'managed') {
        // The server echo (with its id) is the ack; no optimistic append.
        conversationClient.send({ type: 'send', text: trimmed });
        return;
      }

      // E2E: seal per participant key; the server sees ciphertext only.
      if (!identity) return;
      const payload = JSON.stringify({ kind: 'text', text: trimmed, sentAt: Date.now() });
      const selfB64 = toB64(identity.publicKey);
      const keys = new Set<string>();
      for (const p of active.participants) {
        if (p.publicKey) keys.add(p.publicKey);
      }
      keys.add(selfB64); // self-copy → durable history for our own key
      for (const key of keys) {
        const sealed = sealTo(payload, fromB64(key), identity.privateKey);
        conversationClient.send({
          type: 'relay',
          to: key,
          ciphertext: sealed.ciphertext,
          nonce: sealed.nonce,
          persist: true,
        });
      }
      appendMessage({
        id: `local:${Date.now()}:${Math.random()}`,
        participantId: active.selfParticipantId ?? 'me',
        fromName: user?.displayName ?? 'Me',
        fromKind: 'agent',
        mine: true,
        text: trimmed,
        sentAt: Date.now(),
      });
    },

    async assignToMe() {
      const active = get().active;
      if (!active) return;
      await api('POST', `/api/conversations/${active.id}/assign`, { self: true });
      const { conversation } = await api<{ conversation: ConversationDto }>(
        'GET',
        `/api/conversations/${active.id}`,
      );
      set({ active: { ...get().active!, detail: conversation } });
      void get().loadConversations();
    },

    async setConversationStatus(status) {
      const active = get().active;
      if (!active) return;
      await api('POST', `/api/conversations/${active.id}/${status === 'open' ? 'reopen' : 'close'}`);
      set({ active: { ...active, detail: { ...active.detail, status } } });
      void get().loadConversations();
    },

    async loadAgents() {
      const { agents } = await api<{ agents: UserDto[] }>('GET', '/api/org/agents');
      set({ agents });
    },

    async disableAgent(id) {
      await api('DELETE', `/api/org/agents/${id}`);
      await get().loadAgents();
    },

    async loadApiKeys() {
      const { keys } = await api<{ keys: ApiKeyDto[] }>('GET', '/api/org/api-keys');
      set({ apiKeys: keys });
    },
  };
});
