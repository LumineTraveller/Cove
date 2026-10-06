import { useCallback, useReducer, type SetStateAction } from 'react';

export interface ShareLayoutState {
  sharing: boolean;
  chatOpen: boolean;
  animateChat: boolean;
  sidebarOpen: boolean;
  animateControls: boolean;
}

type ShareLayoutAction =
  | { type: 'mode'; sharing: boolean }
  | { type: 'navigation'; open: SetStateAction<boolean> }
  | { type: 'chat'; open: SetStateAction<boolean> };

export function initialShareLayout(sharing: boolean, sidebarOpen = false): ShareLayoutState {
  return { sharing, chatOpen: !sharing, animateChat: false, sidebarOpen, animateControls: false };
}

export function shareLayoutReducer(
  state: ShareLayoutState,
  action: ShareLayoutAction,
): ShareLayoutState {
  if (action.type === 'mode')
    return action.sharing === state.sharing ? state : initialShareLayout(action.sharing, state.sidebarOpen);
  if (action.type === 'navigation') {
    const sidebarOpen = typeof action.open === 'function' ? action.open(state.sidebarOpen) : action.open;
    return sidebarOpen === state.sidebarOpen ? state : { ...state, sidebarOpen, animateControls: true };
  }
  return {
    ...state,
    chatOpen: typeof action.open === 'function' ? action.open(state.chatOpen) : action.open,
    animateChat: state.sharing,
    animateControls: state.sharing || state.animateControls,
  };
}

/** Switch share boundaries atomically; only intentional chat/navigation actions animate. */
export function useShareLayout(sharing: boolean) {
  const [state, dispatch] = useReducer(shareLayoutReducer, sharing, initialShareLayout);
  // Adjust our own state during render so React discards the previous mode's
  // chat state before committing children. An effect permits a narrow/open-chat
  // share to paint first, or ordinary members to inherit the old share geometry.
  if (state.sharing !== sharing) dispatch({ type: 'mode', sharing });
  const setChatOpen = useCallback((open: SetStateAction<boolean>) => {
    dispatch({ type: 'chat', open });
  }, []);
  const setSidebarOpen = useCallback((open: SetStateAction<boolean>) => {
    dispatch({ type: 'navigation', open });
  }, []);
  return {
    chatOpen: state.chatOpen,
    animateShareChat: state.animateChat,
    setChatOpen,
    sidebarOpen: state.sidebarOpen,
    setSidebarOpen,
    animateLayoutControls: state.animateControls,
  };
}
