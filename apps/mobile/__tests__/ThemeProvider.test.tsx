import TestRenderer, { act } from 'react-test-renderer';
import { Text } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  CoveThemeProvider,
  useCoveTheme,
} from '../src/features/settings/ThemeProvider';
import { palettes, THEME_STORAGE_KEY } from '../src/features/settings/theme';

let current: ReturnType<typeof useCoveTheme>;
let renderer: TestRenderer.ReactTestRenderer;
function Surface() {
  current = useCoveTheme();
  return (
    <Text
      style={{
        color: current.colors.text,
        backgroundColor: current.colors.background,
      }}
    >
      {current.theme}
    </Text>
  );
}
const mount = async () => {
  await act(async () => {
    renderer = TestRenderer.create(
      <CoveThemeProvider>
        <Surface />
      </CoveThemeProvider>,
    );
  });
};
beforeEach(() => {
  jest.mocked(AsyncStorage.getItem).mockReset().mockResolvedValue(null);
  jest.mocked(AsyncStorage.setItem).mockReset().mockResolvedValue(undefined);
});
afterEach(async () => {
  if (renderer) await act(async () => renderer.unmount());
});

test('restores the stored theme and applies it to the rendered surface', async () => {
  jest.mocked(AsyncStorage.getItem).mockResolvedValue('dark');
  await mount();
  expect(current.theme).toBe('dark');
  expect(renderer.root.findByType(Text).props.style).toEqual({
    color: palettes.dark.text,
    backgroundColor: palettes.dark.background,
  });
});
test('late storage hydration cannot undo a user theme change', async () => {
  let finishRead!: (value: string) => void;
  jest.mocked(AsyncStorage.getItem).mockReturnValue(
    new Promise(resolve => {
      finishRead = resolve;
    }),
  );
  await mount();
  await act(async () => current.setTheme('dark'));
  await act(async () => finishRead('light'));
  expect(current.theme).toBe('dark');
  expect(AsyncStorage.setItem).toHaveBeenCalledWith(THEME_STORAGE_KEY, 'dark');
});
test('rapid changes persist in order even when an earlier write is slow', async () => {
  let finishWrite!: () => void;
  jest.mocked(AsyncStorage.setItem).mockImplementationOnce(
    () =>
      new Promise(resolve => {
        finishWrite = resolve;
      }),
  );
  await mount();
  await act(async () => current.setTheme('dark'));
  await act(async () => current.setTheme('light'));
  expect(current.theme).toBe('light');
  expect(AsyncStorage.setItem).toHaveBeenCalledTimes(1);
  await act(async () => finishWrite());
  expect(
    jest.mocked(AsyncStorage.setItem).mock.calls.map(call => call[1]),
  ).toEqual(['dark', 'light']);
});
test('unavailable storage still allows changing the displayed theme', async () => {
  jest.mocked(AsyncStorage.getItem).mockRejectedValue(new Error('unavailable'));
  jest.mocked(AsyncStorage.setItem).mockRejectedValue(new Error('unavailable'));
  await mount();
  await act(async () => current.setTheme('dark'));
  expect(current.colors).toEqual(palettes.dark);
});
