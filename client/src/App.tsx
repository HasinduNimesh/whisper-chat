import { useChatStore } from './store/useChatStore';
import { JoinRoom } from './views/JoinRoom';
import { Room } from './views/Room';

export default function App() {
  const status = useChatStore((s) => s.status);
  const inRoom = status === 'joined';

  return (
    <div className="h-full w-full">
      {inRoom ? <Room /> : <JoinRoom />}
    </div>
  );
}
