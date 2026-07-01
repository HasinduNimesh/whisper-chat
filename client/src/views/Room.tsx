import { useChatStore } from '../store/useChatStore';
import { Sidebar } from '../components/Sidebar';
import { ChatHeader } from '../components/ChatHeader';
import { MessageList } from '../components/MessageList';
import { Composer } from '../components/Composer';
import { CallBar } from '../components/CallBar';
import { CallStage } from '../components/CallStage';
import { IncomingCall } from '../components/IncomingCall';

/** WhatsApp-style two-pane layout: contacts/info sidebar + active chat panel. */
export function Room() {
  const inCall = useChatStore((s) => s.inCall);

  return (
    <div className="relative flex h-full w-full overflow-hidden bg-wa-panel">
      <aside className="hidden w-full max-w-[30%] min-w-[300px] flex-col border-r border-wa-border md:flex">
        <Sidebar />
      </aside>

      <main className="flex min-w-0 flex-1 flex-col">
        <ChatHeader />
        {inCall && <CallBar />}
        <CallStage />
        <MessageList />
        <Composer />
      </main>

      <IncomingCall />
    </div>
  );
}
