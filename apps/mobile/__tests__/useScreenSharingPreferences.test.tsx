import AsyncStorage from '@react-native-async-storage/async-storage';
import TestRenderer, { act } from 'react-test-renderer';
import {
  SCREEN_SHARE_AUDIO_KEY,
  useScreenSharingPreferences,
} from '../src/features/media/screen/useScreenSharingPreferences';
let result: ReturnType<typeof useScreenSharingPreferences>;
let renderer: TestRenderer.ReactTestRenderer;
function Harness() {
  result = useScreenSharingPreferences();
  return null;
}
beforeEach(() => {
  jest.clearAllMocks();
  (AsyncStorage.getItem as jest.Mock).mockResolvedValue(null);
  (AsyncStorage.setItem as jest.Mock).mockResolvedValue(undefined);
});
afterEach(async () => {
  await act(async () => renderer.unmount());
});
test('restores the app-wide screen audio preference without adding an unsupported frame rate option', async () => {
  (AsyncStorage.getItem as jest.Mock).mockResolvedValue('true');
  await act(async () => {
    renderer = TestRenderer.create(<Harness />);
  });
  expect(AsyncStorage.getItem).toHaveBeenCalledWith(SCREEN_SHARE_AUDIO_KEY);
  expect(result.includeScreenAudio).toBe(true);
});
test('a late async restore never overrides even an explicit choice equal to the initial default', async () => {
  let restore!: (value: string) => void;
  (AsyncStorage.getItem as jest.Mock).mockImplementationOnce(
    () =>
      new Promise(resolve => {
        restore = resolve;
      }),
  );
  await act(async () => {
    renderer = TestRenderer.create(<Harness />);
  });
  await act(async () => {
    result.setIncludeScreenAudio(false);
    restore('true');
  });
  expect(result.includeScreenAudio).toBe(false);
  expect(AsyncStorage.setItem).toHaveBeenCalledWith(
    SCREEN_SHARE_AUDIO_KEY,
    'false',
  );
});
test('rapid switches serialize storage writes so a slow first save cannot win last', async () => {
  let firstSaved!: () => void;
  (AsyncStorage.setItem as jest.Mock).mockImplementationOnce(
    () =>
      new Promise<void>(resolve => {
        firstSaved = resolve;
      }),
  );
  await act(async () => {
    renderer = TestRenderer.create(<Harness />);
  });
  await act(async () => {
    result.setIncludeScreenAudio(true);
  });
  await act(async () => {
    result.setIncludeScreenAudio(false);
    result.setIncludeScreenAudio(true);
  });
  expect(AsyncStorage.setItem).toHaveBeenCalledTimes(1);
  await act(async () => {
    firstSaved();
  });
  expect((AsyncStorage.setItem as jest.Mock).mock.calls).toEqual([
    [SCREEN_SHARE_AUDIO_KEY, 'true'],
    [SCREEN_SHARE_AUDIO_KEY, 'false'],
    [SCREEN_SHARE_AUDIO_KEY, 'true'],
  ]);
  expect(result.includeScreenAudio).toBe(true);
});
test('a new mount waits for the last explicit choice while an old restore is ignored', async () => {
  let restore!: (value: string) => void;
  (AsyncStorage.getItem as jest.Mock)
    .mockImplementationOnce(
      () =>
        new Promise(resolve => {
          restore = resolve;
        }),
    )
    .mockResolvedValue('false');
  await act(async () => {
    renderer = TestRenderer.create(<Harness />);
  });
  await act(async () => {
    result.setIncludeScreenAudio(false);
    renderer.unmount();
  });
  await act(async () => {
    renderer = TestRenderer.create(<Harness />);
    restore('true');
  });
  expect(result.includeScreenAudio).toBe(false);
});
