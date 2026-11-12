import { createContext, useContext, useEffect, useLayoutEffect, useState, type ReactNode } from 'react';

export type Theme = 'light' | 'dark';
export const TEXT_SIZES = [
  { value: 100, label: 'Bình thường' },
  { value: 125, label: 'Lớn' },
  { value: 150, label: 'Rất lớn' },
  { value: 200, label: 'Lớn nhất' },
] as const;
export type TextSize = typeof TEXT_SIZES[number]['value'];
const validTextSize = (value: number): value is TextSize => TEXT_SIZES.some(option => option.value === value);
const ThemeContext = createContext<{
  theme: Theme; setTheme: (theme: Theme) => void;
  textSize: TextSize; setTextSize: (size: TextSize) => void;
}>({ theme: 'light', setTheme: () => undefined, textSize: 100, setTextSize: () => undefined });

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setTheme] = useState<Theme>(() => document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light');
  const [textSize, setTextSize] = useState<TextSize>(() => {
    try {
      const saved = Number(localStorage.getItem('camera-station.text-size'));
      if (validTextSize(saved)) return saved;
    } catch { /* Use the initial page preference when storage is unavailable. */ }
    const initial = Number(document.documentElement.dataset.textSize);
    return validTextSize(initial) ? initial : 100;
  });
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    document.documentElement.style.colorScheme = theme;
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', theme === 'dark' ? '#0e1725' : '#f5f8fc');
    try { localStorage.setItem('camera-station.theme', theme); } catch { /* Works without persistent storage. */ }
  }, [theme]);
  useLayoutEffect(() => {
    document.documentElement.dataset.textSize = String(textSize);
    document.documentElement.style.setProperty('--text-scale', String(textSize / 100));
    try { localStorage.setItem('camera-station.text-size', String(textSize)); } catch { /* Works without persistent storage. */ }
  }, [textSize]);
  return <ThemeContext.Provider value={{ theme, setTheme, textSize, setTextSize }}>{children}</ThemeContext.Provider>;
}

export const useTheme = () => useContext(ThemeContext);
