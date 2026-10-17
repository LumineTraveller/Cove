// Only unrelated surfaces/transports are replaced. Auth modules stay real.
module.exports = {
  'src/features/rooms/ChatRoomV2.tsx': 'export default function ChatRoomV2(){return null}',
  'src/features/rooms/RoomList.tsx': 'export default function RoomList(){return null}',
  'src/features/updates/components/UpdateCenter.tsx': 'export function UpdateCenter(){return null}',
  'src/features/connection/socket.ts': `
    const listeners = new Map();
    export const socket = {
      connected:false, id:'fictional-offline-socket', auth:{}, io:{opts:{}},
      on(event,listener){if(!listeners.has(event))listeners.set(event,new Set());listeners.get(event).add(listener);return this},
      off(event,listener){listeners.get(event)?.delete(listener);return this},
      listeners(event){return [...(listeners.get(event)||[])]},
      timeout(){return this},
      emit(){return this},
      connect(){throw new Error('Offline login fixture must not connect a socket')},
      disconnect(){this.connected=false;return this},
    };
    export const getServerURL=()=>localStorage.getItem('cove_server_url')||'https://login-a.example.test';
    export const getClientId=()=> 'fictional-offline-client';
    export const applyServerAccessToSocket=()=>{};
  `,
};
