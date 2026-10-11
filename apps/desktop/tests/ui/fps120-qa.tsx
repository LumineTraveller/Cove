/*
 * Reuse the real ChatRoomV2/useWebRTC integration fixture and its synthetic
 * socket/SFU/media devices. The runner drives the production settings UI.
 * No screen, microphone, account, or physical device metadata is read.
 */
import {
  loadScreenPreferences,
  SCREEN_PREFERENCES_KEY,
} from '../../src/features/media/screen/screenPreferences';

// Avoid physical device enumeration before the existing fixture mounts hooks.
navigator.mediaDevices.enumerateDevices = async () => [];

const captures: MediaStreamConstraints[] = [];
const alerts: string[] = [];
window.alert = (message?: unknown) => { alerts.push(String(message)); };

await import('./share-chat-qa');

// The imported fixture replaced both capture methods with canvas/oscillator
// streams. Record the real publishing hook's constraints without touching OS
// capture. The generated video is deliberately 30 FPS, not a hardware claim.
const syntheticDisplayCapture = navigator.mediaDevices.getDisplayMedia.bind(navigator.mediaDevices);
navigator.mediaDevices.getDisplayMedia = async (constraints) => {
  captures.push(structuredClone(constraints ?? {}));
  return syntheticDisplayCapture(constraints);
};

(window as any).coveFpsQa = {
  ready: true,
  preferencesKey: SCREEN_PREFERENCES_KEY,
  snapshot: () => ({
    preferences: loadScreenPreferences(),
    stored: localStorage.getItem(SCREEN_PREFERENCES_KEY),
    captures: structuredClone(captures),
    alerts: [...alerts],
    actualProductRoom: Boolean(document.querySelector('.cove-shell')),
    selfSharing: Boolean(document.querySelector('.mode-self')),
    modal: Boolean(document.querySelector('.screen-settings')),
    fpsButtons: [...document.querySelectorAll<HTMLButtonElement>('.fps-grid button')].map(button => ({
      label: button.textContent?.trim(),
      active: button.classList.contains('active'),
      disabled: button.disabled,
      rect: button.getBoundingClientRect().toJSON(),
    })),
    selectedResolution: document.querySelector('.resolution-grid .active')?.textContent?.trim() ?? null,
    toggles: [...document.querySelectorAll<HTMLInputElement>('.screen-settings input[type="checkbox"]')]
      .map(input => ({ checked: input.checked, disabled: input.disabled })),
    note: document.querySelector('.screen-settings-note')?.textContent?.trim() ?? null,
  }),
};
