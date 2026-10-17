import AsyncStorage from '@react-native-async-storage/async-storage';
import TestRenderer, { act } from 'react-test-renderer';
import {
  SCREEN_SHARE_AUDIO_KEY,
  SCREEN_SHARE_SCALE_KEY,
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

test.each(['1', '0.75', '0.5'])(
  'restores the supported capture scale %s separately from audio',
  async value => {
    (AsyncStorage.getItem as jest.Mock).mockImplementation(async key =>
      key === SCREEN_SHARE_SCALE_KEY ? value : 'true',
    );
    await act(async () => {
      renderer = TestRenderer.create(<Harness />);
    });
    expect(result.screenCaptureScale).toBe(Number(value));
    expect(result.includeScreenAudio).toBe(true);
    expect(AsyncStorage.getItem).toHaveBeenCalledWith(SCREEN_SHARE_SCALE_KEY);
  },
);

test.each([null, '', 'NaN', '0', '2', '0.8'])(
  'falls back to original capture scale for malformed or unsupported stored value %s',
  async value => {
    (AsyncStorage.getItem as jest.Mock).mockResolvedValue(value);
    await act(async () => {
      renderer = TestRenderer.create(<Harness />);
    });
    expect(result.screenCaptureScale).toBe(1);
  },
);

test('a late scale restore cannot overwrite an explicit original-size choice while audio still restores', async () => {
  let restoreScale!: (value: string) => void;
  (AsyncStorage.getItem as jest.Mock).mockImplementation(key =>
    key === SCREEN_SHARE_SCALE_KEY
      ? new Promise(resolve => {
          restoreScale = resolve;
        })
      : Promise.resolve('true'),
  );
  await act(async () => {
    renderer = TestRenderer.create(<Harness />);
  });
  await act(async () => {
    result.setScreenCaptureScale(1);
    restoreScale('0.5');
  });
  expect(result.screenCaptureScale).toBe(1);
  expect(result.includeScreenAudio).toBe(true);
  expect(AsyncStorage.setItem).toHaveBeenCalledWith(
    SCREEN_SHARE_SCALE_KEY,
    '1',
  );
});

test('an audio choice does not suppress a still-pending scale restore', async () => {
  let restoreScale!: (value: string) => void;
  (AsyncStorage.getItem as jest.Mock).mockImplementation(key =>
    key === SCREEN_SHARE_SCALE_KEY
      ? new Promise(resolve => {
          restoreScale = resolve;
        })
      : Promise.resolve('true'),
  );
  await act(async () => {
    renderer = TestRenderer.create(<Harness />);
  });
  await act(async () => {
    result.setIncludeScreenAudio(false);
    restoreScale('0.75');
  });
  expect(result.screenCaptureScale).toBe(0.75);
  expect(result.includeScreenAudio).toBe(false);
});

test('scale writes remain ordered across mounts and do not block independent audio writes', async () => {
  let firstSaved!: () => void;
  (AsyncStorage.setItem as jest.Mock).mockImplementation((key, value) => {
    if (key === SCREEN_SHARE_SCALE_KEY && value === '0.5')
      return new Promise<void>(resolve => {
        firstSaved = resolve;
      });
    return Promise.resolve();
  });
  (AsyncStorage.getItem as jest.Mock).mockImplementation(async key =>
    key === SCREEN_SHARE_SCALE_KEY ? '0.75' : 'true',
  );
  await act(async () => {
    renderer = TestRenderer.create(<Harness />);
  });
  await act(async () => {
    result.setScreenCaptureScale(0.5);
  });
  await act(async () => {
    result.setScreenCaptureScale(0.75);
    result.setIncludeScreenAudio(true);
    renderer.unmount();
    renderer = TestRenderer.create(<Harness />);
  });
  expect(AsyncStorage.setItem).toHaveBeenCalledWith(
    SCREEN_SHARE_AUDIO_KEY,
    'true',
  );
  expect(
    (AsyncStorage.setItem as jest.Mock).mock.calls.filter(
      ([key]) => key === SCREEN_SHARE_SCALE_KEY,
    ),
  ).toEqual([[SCREEN_SHARE_SCALE_KEY, '0.5']]);
  await act(async () => {
    firstSaved();
  });
  expect(
    (AsyncStorage.setItem as jest.Mock).mock.calls.filter(
      ([key]) => key === SCREEN_SHARE_SCALE_KEY,
    ),
  ).toEqual([
    [SCREEN_SHARE_SCALE_KEY, '0.5'],
    [SCREEN_SHARE_SCALE_KEY, '0.75'],
  ]);
  expect(result.screenCaptureScale).toBe(0.75);
});

test('a failed scale save does not prevent the next explicit choice from saving', async () => {
  (AsyncStorage.setItem as jest.Mock).mockRejectedValueOnce(
    new Error('storage unavailable'),
  );
  await act(async () => {
    renderer = TestRenderer.create(<Harness />);
  });
  await act(async () => {
    result.setScreenCaptureScale(0.5);
    result.setScreenCaptureScale(0.75);
  });
  expect(AsyncStorage.setItem).toHaveBeenLastCalledWith(
    SCREEN_SHARE_SCALE_KEY,
    '0.75',
  );
  expect(result.screenCaptureScale).toBe(0.75);
});
