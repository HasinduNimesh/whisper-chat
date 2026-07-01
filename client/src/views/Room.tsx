import { Sidebar } from '../components/Sidebar';
import { ChatHeader } from '../components/ChatHeader';
import { MessageList } from '../components/MessageList';
import { Composer } from '../components/Composer';
import { CallOverlay } from '../components/CallOverlay';
import { CallErrorToast } from '../components/CallErrorToast';
import { IncomingCall } from '../components/IncomingCall';

/** WhatsApp-style two-pane layout: contacts/info sidebar + active chat panel. */
export function Room() {
  return (
    <div className="relative flex h-full w-full overflow-hidden bg-wa-panel">
      <aside className="hidden w-full max-w-[30%] min-w-[300px] flex-col border-r border-wa-border md:flex">
        <Sidebar />
      </aside>

      <main className="flex min-w-0 flex-1 flex-col">
        <ChatHeader />
        {/* Shows a call failure (e.g. permission denied) that happened
            before CallOverlay ever had a reason to render. */}
        <CallErrorToast />
        {/* Renders the compact "return to call" bar or the full-screen call
            view (CallStage) depending on minimized state. */}
        <CallOverlay />
        <MessageList />
        <Composer />
      </main>

      <IncomingCall />
    </div>
  );
}
