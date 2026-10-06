import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { RemoteScreenVideo } from '../../src/features/media/screen/ScreenVideo';
import '../../src/styles/index.css';
import '../../src/styles/ui-v2.css';

const canvas = document.createElement('canvas');
canvas.width = 720; canvas.height = 1280;
canvas.getContext('2d')!.fillRect(0, 0, 720, 1280);
const stream = canvas.captureStream(1);
const inputs: unknown[] = [];
const onInput = (input: unknown) => inputs.push(input);
function Fixture() {
  const [active, setActive] = useState(false);
  const [visible, setVisible] = useState(true);
  (window as any).cursorQa = { setActive, setVisible, inputs };
  return <div style={{padding:20}}><button id="outside">Outside control area</button>
    {visible && <div style={{width:700,height:420,marginTop:20}}>
      <RemoteScreenVideo stream={stream} controlling={active} onInput={onInput} />
    </div>}
  </div>;
}
createRoot(document.getElementById('root')!).render(<Fixture />);
