import { create } from "zustand";
import { persist } from "zustand/middleware";

type Theme = "dark" | "light";

interface ThemeState {
  theme: Theme;
  toggleTheme: () => void;
  setTheme: (theme: Theme) => void;
}

function applyTheme(theme: Theme) {
  document.documentElement.dataset.theme = theme;
}

export const useTheme = create<ThemeState>()(
  persist(
    (set) => ({
      theme: "dark",
      toggleTheme: () => set((state) => {
        const theme = state.theme === "dark" ? "light" : "dark";
        applyTheme(theme);
        return { theme };
      }),
      setTheme: (theme) => {
        applyTheme(theme);
        set({ theme });
      },
    }),
    {
      name: "accessibility-theme",
      onRehydrateStorage: () => (state) => {
        applyTheme(state?.theme || "dark");
      },
    }
  )
);


