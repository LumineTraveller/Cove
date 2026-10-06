import { createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import RoomList from '../../src/features/rooms/RoomList';
import '../../src/styles/index.css';

const theme = new URLSearchParams(window.location.search).get('theme') === 'dark' ? 'dark' : 'light';
document.documentElement.dataset.theme = theme;
document.documentElement.style.colorScheme = theme;

createRoot(document.getElementById('root')).render(
  createElement(
    MemoryRouter,
    {
      initialEntries: [
        {
          pathname: '/',
          state: { roomKickNotice: '你已被测试房主移出频道。' },
        },
      ],
    },
    createElement(RoomList, {
      profile: { username: '测试用户', avatarUrl: null },
      onProfileChange: () => {},
      accountId: 'fixture-user',
      onLogout: () => {},
      sessionReady: false,
      serverURL: '',
      theme,
      onThemeChange: () => {},
    }),
  ),
);
