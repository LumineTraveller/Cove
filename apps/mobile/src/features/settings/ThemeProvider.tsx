import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  palettes,
  THEME_STORAGE_KEY,
  type AppTheme,
  type CoveColors,
} from './theme';
const ThemeContext = createContext({
  theme: 'light' as AppTheme,
  colors: palettes.light,
  setTheme: (_theme: AppTheme) => {},
});
export function CoveThemeProvider({ children }: { children: ReactNode }) {
  const [theme, updateTheme] = useState<AppTheme>('light');
  const selected = useRef(false);
  const writes = useRef<Promise<unknown>>(Promise.resolve());
  useEffect(() => {
    let active = true;
    void AsyncStorage.getItem(THEME_STORAGE_KEY)
      .then(value => {
        if (
          active &&
          !selected.current &&
          (value === 'light' || value === 'dark')
        )
          updateTheme(value);
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, []);
  const setTheme = useCallback((next: AppTheme) => {
    selected.current = true;
    updateTheme(next);
    writes.current = writes.current
      .catch(() => {})
      .then(() => AsyncStorage.setItem(THEME_STORAGE_KEY, next))
      .catch(() => {});
  }, []);
  const value = useMemo(
    () => ({ theme, colors: palettes[theme], setTheme }),
    [theme, setTheme],
  );
  return (
    <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>
  );
}
export function useCoveTheme() {
  return useContext(ThemeContext);
}
export function useThemedStyles<T>(factory: (colors: CoveColors) => T): T {
  const { colors: current } = useCoveTheme();
  return useMemo(() => factory(current), [current, factory]);
}
