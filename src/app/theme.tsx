import { useEffect, useState } from 'react';

export type Theme = 'dark' | 'light' | 'system';

function read(): Theme {
  try {
    const t = localStorage.getItem('theme');
    return t === 'light' || t === 'system' ? t : 'dark';
  } catch {
    return 'dark';
  }
}

export function useTheme(): [Theme, (t: Theme) => void] {
  const [theme, setTheme] = useState<Theme>(read);
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    try {
      localStorage.setItem('theme', theme);
    } catch {
      /* armazenamento indisponível */
    }
  }, [theme]);
  return [theme, setTheme];
}
