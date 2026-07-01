import { create } from "zustand";
import { persist } from "zustand/middleware";
import { api } from "../services/api";

interface User {
  id: string;
  email: string;
  full_name: string;
  role: string;
  avatar_url?: string;
}

interface AuthState {
  user: User | null;
  accessToken: string | null;
  refreshToken: string | null;
  login: (email: string, password: string) => Promise<void>;
  logout: () => void;
  setTokens: (access: string, refresh: string) => void;
}

export const useAuth = create<AuthState>()(
  persist(
    (set, get) => ({
      user: null,
      accessToken: null,
      refreshToken: null,

      login: async (email, password) => {
        const { data } = await api.post("/auth/login", { email, password });
        set({
          user: data.user,
          accessToken: data.access_token,
          refreshToken: data.refresh_token
        });
        api.defaults.headers.common["Authorization"] = `Bearer ${data.access_token}`;
      },

      logout: () => {
        api.post("/auth/logout").catch(() => {});
        delete api.defaults.headers.common["Authorization"];
        set({ user: null, accessToken: null, refreshToken: null });
      },

      setTokens: (access, refresh) => {
        set({ accessToken: access, refreshToken: refresh });
        api.defaults.headers.common["Authorization"] = `Bearer ${access}`;
      }
    }),
    {
      name: "accessibility-auth",
      partialize: (s) => ({ user: s.user, accessToken: s.accessToken, refreshToken: s.refreshToken })
    }
  )
);


