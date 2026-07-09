/**
 * Widget (iframe app) state: bootstrap → conversation → live chat. Mirrors
 * the dashboard store's message handling; identity here is a visitor secret
 * (anonymous B2C) or a store-signed token (identified B2C / C2C).
 *
 * E2E orgs: the visitor keypair lives in the IFRAME's origin storage and
 * sealing/opening happens here — plaintext never reaches the server.
 */
import { create } from 'zustand';
import type { ChatPayload, ConversationPeer, HistoryEntry, ServerMessage } from '@private-chat/shared';
import { SignalingClient, signalingUrl } from '../signaling/client';
import {
  fromB64,
  generateIdentity,
  initCrypto,
  openFrom,
  sealTo,
  toB64,
  type Identity,
} from '../crypto/index';
import { ensureConversation, ensureVisitorSession } from './visitorSession';
import type { BridgeInit } from './bridge';

export interface WidgetMessage {
  id: string;
  fromKey: string;
  fromName: string;
  mine: boolean;
  text: string;
  sentAt: number;
}

interface WidgetState {
  status: 'boot' | 'connecting' | 'ready' | 'error';
  error: string | null;
  orgName: string;
  encryption: 'e2e' | 'managed' | null;
  conversationStatus: 'open' | 'closed';
  connected: boolean;
  participants: ConversationPeer[];
  messages: WidgetMessage[];
  selfParticipantId: string | null;
  visible: boolean;
  unread: number;

  configure: (init: BridgeInit, notify: (type: string, payload?: unknown) => void) => Promise<void>;
  setVisible: (open: boolean) => void;
  sendMessage: (text: string) => void;
}

let client: SignalingClient | null = null;
let identity: Identity | null = null;
let notifyParent: (type: string, payload?: unknown) => void = () => {};

const identityKeyFor = (orgSlug: string) => `whisper.widget.identity.v1.${orgSlug}`;

async function loadWidgetIdentity(orgSlug: string): Promise<Identity> {
  await initCrypto();
  const raw = localStorage.getItem(identityKeyFor(orgSlug));
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as { publicKey: string; privateKey: string };
      return { publicKey: fromB64(parsed.publicKey), privateKey: fromB64(parsed.privateKey) };
    } catch {
      /* regenerate below */
    }
  }
  const id = generateIdentity();
  localStorage.setItem(
    identityKeyFor(orgSlug),
    JSON.stringify({ publicKey: toB64(id.publicKey), privateKey: toB64(id.privateKey) }),
  );
  return id;
}

export const useWidgetStore = create<WidgetState>((set, get) => {
  function appendMessage(m: WidgetMessage): void {
    const { messages, visible, unread } = get();
    if (messages.some((x) => x.id === m.id)) return;
    const nextUnread = !visible && !m.mine ? unread + 1 : unread;
    set({ messages: [...messages, m], unread: nextUnread });
    if (nextUnread !== unread) notifyParent('unread', nextUnread);
  }

  function decryptEntry(entry: HistoryEntry): WidgetMessage | null {
    if (!identity) return null;
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
        fromKey: entry.fromPublicKey,
        fromName: entry.fromDisplayName,
        mine: entry.fromPublicKey === toB64(identity.publicKey),
        text: payload.text,
        sentAt: payload.sentAt ?? entry.sentAt,
      };
    } catch {
      return null; // fail closed
    }
  }

  function onServerMessage(msg: ServerMessage): void {
    if (msg.type === 'conversation-joined') {
      const history: WidgetMessage[] = [];
      for (const h of msg.history ?? []) {
        history.push({
          id: h.id,
          fromKey: h.from.participantId,
          fromName: h.from.displayName,
          mine: h.from.participantId === msg.selfParticipantId,
          text: h.text,
          sentAt: h.sentAt,
        });
      }
      for (const entry of msg.e2eHistory ?? []) {
        const m = decryptEntry(entry);
        if (m) history.push(m);
      }
      set({
        status: 'ready',
        connected: true,
        selfParticipantId: msg.selfParticipantId,
        participants: msg.participants,
        conversationStatus: msg.conversation.status,
        messages: history,
      });
      return;
    }
    if (msg.type === 'message') {
      appendMessage({
        id: msg.id,
        fromKey: msg.from.participantId,
        fromName: msg.from.displayName,
        mine: msg.from.participantId === get().selfParticipantId,
        text: msg.text,
        sentAt: msg.sentAt,
      });
      return;
    }
    if (msg.type === 'deliver') {
      const sender = get().participants.find((p) => p.publicKey === msg.from);
      const m = decryptEntry({
        fromPublicKey: msg.from,
        fromDisplayName: sender?.displayName ?? 'Agent',
        ciphertext: msg.ciphertext,
        nonce: msg.nonce,
        sentAt: Date.now(),
      });
      if (m) appendMessage(m);
      return;
    }
    if (msg.type === 'conversation-peer') {
      const rest = get().participants.filter((p) => p.participantId !== msg.peer.participantId);
      set({ participants: [...rest, msg.peer] });
      return;
    }
    if (msg.type === 'error') {
      if (msg.code === 'conversation-closed') {
        set({ conversationStatus: 'closed' });
      } else {
        set({ error: msg.message });
      }
    }
  }

  return {
    status: 'boot',
    error: null,
    orgName: '',
    encryption: null,
    conversationStatus: 'open',
    connected: false,
    participants: [],
    messages: [],
    selfParticipantId: null,
    visible: false,
    unread: 0,

    async configure(init: BridgeInit, notify) {
      notifyParent = notify;
      set({ status: 'connecting', error: null });
      try {
        let auth:
          | { kind: 'visitor'; orgSlug: string; secret: string }
          | { kind: 'org-token'; token: string };
        let conversation;

        if (init.token) {
          // Identified path: the token is the credential and the conv key.
          conversation = await ensureConversation({ orgSlug: init.orgSlug, token: init.token });
          if (conversation.encryption === 'e2e') {
            identity = await loadWidgetIdentity(init.orgSlug);
            conversation = await ensureConversation({
              orgSlug: init.orgSlug,
              token: init.token,
              publicKey: toB64(identity.publicKey),
            });
          }
          auth = { kind: 'org-token', token: init.token };
          set({ encryption: conversation.encryption, conversationStatus: conversation.status });
        } else {
          // Anonymous path: visitor secret in iframe-origin storage.
          const session = await ensureVisitorSession(init.orgSlug);
          if (session.encryptionMode === 'e2e') {
            identity = await loadWidgetIdentity(init.orgSlug);
          }
          conversation = await ensureConversation({
            orgSlug: init.orgSlug,
            visitorSecret: session.visitorSecret,
            ...(identity ? { publicKey: toB64(identity.publicKey) } : {}),
          });
          auth = { kind: 'visitor', orgSlug: init.orgSlug, secret: session.visitorSecret };
          set({
            orgName: session.orgName,
            encryption: session.encryptionMode,
            conversationStatus: conversation.status,
          });
        }

        client?.close();
        client = new SignalingClient(signalingUrl(), {
          onMessage: onServerMessage,
          onClose: () => set({ connected: false }),
        });
        client.connect();
        client.send({
          type: 'join-conversation',
          conversationId: conversation.conversationId,
          auth,
          ...(identity ? { publicKey: toB64(identity.publicKey) } : {}),
        });
      } catch (err) {
        set({ status: 'error', error: err instanceof Error ? err.message : 'Could not start chat' });
      }
    },

    setVisible(open) {
      set({ visible: open, ...(open ? { unread: 0 } : {}) });
      if (open) notifyParent('unread', 0);
    },

    sendMessage(text) {
      const state = get();
      const trimmed = text.trim();
      if (!client || !trimmed || state.conversationStatus === 'closed') return;

      if (state.encryption === 'managed') {
        client.send({ type: 'send', text: trimmed }); // echo is the ack
        return;
      }
      if (!identity) return;
      const payload = JSON.stringify({ kind: 'text', text: trimmed, sentAt: Date.now() });
      const selfB64 = toB64(identity.publicKey);
      const keys = new Set<string>([selfB64]);
      for (const p of state.participants) if (p.publicKey) keys.add(p.publicKey);
      for (const key of keys) {
        const sealed = sealTo(payload, fromB64(key), identity.privateKey);
        client.send({ type: 'relay', to: key, ciphertext: sealed.ciphertext, nonce: sealed.nonce, persist: true });
      }
      appendMessage({
        id: `local:${Date.now()}:${Math.random()}`,
        fromKey: selfB64,
        fromName: 'You',
        mine: true,
        text: trimmed,
        sentAt: Date.now(),
      });
    },
  };
});
