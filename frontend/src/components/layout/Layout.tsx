import { Outlet, NavLink, useNavigate } from "react-router-dom";
import { useAuth } from "../../store/auth";
import { useTheme } from "../../store/theme";
import {
  LayoutDashboard, Plus, LogOut, ChevronDown, Moon, Sun, History,
  ArrowUp, ArrowDown, PanelLeftClose, PanelLeftOpen, Users, ShieldCheck
} from "lucide-react";
import { useEffect, useRef, useState } from "react";

export default function Layout() {
  const { user, logout } = useAuth();
  const { theme, toggleTheme, setTheme } = useTheme();
  const navigate = useNavigate();
  const mainRef = useRef<HTMLElement | null>(null);
  const [userMenuOpen, setUserMenuOpen] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [nearTop, setNearTop] = useState(true);

  useEffect(() => {
    setTheme(theme);
  }, [theme, setTheme]);

    const getScrollTarget = () => {
    const root = mainRef.current;
    if (!root) return null;

    const candidates = [root, ...Array.from(root.querySelectorAll<HTMLElement>("*"))]
      .filter(el => el.scrollHeight - el.clientHeight > 8);

    const active = candidates.find(el => el.scrollTop > 8);
    if (active) return active;

    return candidates.sort((a, b) => (b.scrollHeight - b.clientHeight) - (a.scrollHeight - a.clientHeight))[0] || root;
  };

  const handleScroll = () => {
    const el = getScrollTarget();
    if (!el) return;
    const maxScroll = Math.max(0, el.scrollHeight - el.clientHeight);
    setNearTop(el.scrollTop < Math.max(120, maxScroll / 2));
  };

  const handleScrollJump = () => {
    const el = getScrollTarget();
    if (!el) return;
    const maxScroll = Math.max(0, el.scrollHeight - el.clientHeight);
    const shouldGoDown = el.scrollTop < Math.max(120, maxScroll / 2);
    el.scrollTo({ top: shouldGoDown ? maxScroll : 0, behavior: "smooth" });
    setNearTop(!shouldGoDown);
  };

  const handleLogout = () => {
    logout();
    navigate("/login");
  };

  const navItems = [
    { to: "/", icon: LayoutDashboard, label: "Dashboard", end: true },
    { to: "/history", icon: History, label: "History" },
    { to: "/scans/new", icon: Plus, label: "New Scan" },
    ...(user?.role === "admin" ? [
      { to: "/users", icon: Users, label: "Users" },
      { to: "/wcag-governance", icon: ShieldCheck, label: "WCAG Governance" }
    ] : [])
  ];

  return (
    <div className="flex h-screen overflow-hidden app-shell-bg">
      <aside
        className={`${sidebarCollapsed ? "w-20" : "w-60"} flex-shrink-0 flex flex-col transition-all duration-200`}
        style={{ background: "var(--surface-2)", borderRight: "1px solid var(--border)", boxShadow: "12px 0 32px rgba(7,17,31,0.16)" }}
      >
        <div className={`flex items-center gap-2.5 ${sidebarCollapsed ? "px-3 justify-center" : "px-5"} py-5 border-b`} style={{ borderColor: "var(--border)" }}>
          {!sidebarCollapsed && (
            <div className="min-w-0 flex items-center gap-2.5">
              <div className="sky-wordmark text-3xl flex-shrink-0">sky</div>
              <div className="min-w-0">
                <div className="text-sm font-semibold leading-none truncate" style={{ color: "var(--text-strong)" }}>Axessia</div>
                <div className="text-[10px] mt-0.5 truncate" style={{ color: "var(--muted)" }}>Accessibility Platform</div>
              </div>
            </div>
          )}
          {sidebarCollapsed && <div className="sky-wordmark text-2xl">sky</div>}
          <button
            type="button"
            onClick={() => setSidebarCollapsed(v => !v)}
            className={`${sidebarCollapsed ? "" : "ml-auto"} h-8 w-8 rounded-lg border flex items-center justify-center hover:bg-white/[0.04] transition-all`}
            style={{ borderColor: "var(--border)", color: "var(--muted-strong)", background: "var(--surface-1)" }}
            aria-label={sidebarCollapsed ? "Expand sidebar" : "Collapse sidebar"}
            title={sidebarCollapsed ? "Expand sidebar" : "Collapse sidebar"}
          >
            {sidebarCollapsed ? <PanelLeftOpen size={15} /> : <PanelLeftClose size={15} />}
          </button>
        </div>

        <nav className="flex-1 px-3 py-4 space-y-0.5">
          {navItems.map(({ to, icon: Icon, label, end }) => (
            <NavLink key={to} to={to} end={end}
              title={sidebarCollapsed ? label : undefined}
              className={({ isActive }) =>
                `flex items-center ${sidebarCollapsed ? "justify-center px-2" : "gap-2.5 px-3"} py-2.5 rounded-lg text-sm transition-all ${
                  isActive ? "selected-tab-solid font-semibold" : "text-slate-500 hover:text-slate-300 hover:bg-white/[0.04]"
                }`
              }
            >
              <Icon size={16} />
              {!sidebarCollapsed && label}
            </NavLink>
          ))}
        </nav>

        <div className="px-3 pb-3">
          <button
            onClick={toggleTheme}
            className={`w-full flex items-center ${sidebarCollapsed ? "justify-center px-2" : "justify-between gap-2.5 px-3"} py-2.5 rounded-lg text-sm transition-all hover:bg-white/[0.04]`}
            style={{ color: "var(--muted-strong)", border: "1px solid var(--border)", background: "var(--surface-1)" }}
            title={theme === "dark" ? "Dark theme" : "Light theme"}
          >
            <span className="flex items-center gap-2">
              {theme === "dark" ? <Moon size={15} /> : <Sun size={15} />}
              {!sidebarCollapsed && (theme === "dark" ? "Dark theme" : "Light theme")}
            </span>
            {!sidebarCollapsed && <span className="text-[10px]" style={{ color: "var(--muted)" }}>Switch</span>}
          </button>
        </div>

        <div className="px-3 pb-4 border-t pt-3" style={{ borderColor: "var(--border)" }}>
          <div className="relative">
            <button
              onClick={() => setUserMenuOpen(!userMenuOpen)}
              className={`w-full flex items-center ${sidebarCollapsed ? "justify-center px-2" : "gap-2.5 px-3"} py-2.5 rounded-lg text-sm hover:bg-white/[0.04] transition-all`}
              style={{ color: "var(--muted-strong)" }}
            >
              <div className="w-7 h-7 rounded-full flex items-center justify-center text-xs font-bold flex-shrink-0"
                style={{ background: "linear-gradient(135deg, #0f766e40, #6e56cf45)", color: "#0f766e" }}>
                {user?.full_name?.[0]?.toUpperCase()}
              </div>
              {!sidebarCollapsed && (
                <>
                  <div className="flex-1 min-w-0 text-left">
                    <div className="text-xs font-medium truncate" style={{ color: "var(--text)" }}>{user?.full_name}</div>
                    <div className="text-[10px] truncate" style={{ color: "var(--muted)" }}>{user?.role}</div>
                  </div>
                  <ChevronDown size={12} className={`transition-transform ${userMenuOpen ? "rotate-180" : ""}`} />
                </>
              )}
            </button>
            {userMenuOpen && !sidebarCollapsed && (
              <div className="absolute bottom-full left-0 right-0 mb-1 py-1 rounded-lg overflow-hidden"
                style={{ background: "var(--surface-2)", border: "1px solid var(--border)" }}>
                <button onClick={handleLogout}
                  className="w-full flex items-center gap-2 px-3 py-2 text-xs text-red-400 hover:bg-white/[0.04] transition-colors">
                  <LogOut size={13} /> Sign out
                </button>
              </div>
            )}
          </div>
        </div>
      </aside>

      <main ref={mainRef} onScrollCapture={handleScroll} className="flex-1 overflow-y-auto relative">
        <Outlet />
        <button
          type="button"
          onClick={handleScrollJump}
          className="sky-primary fixed bottom-5 right-5 z-40 h-11 w-11 rounded-full border shadow-xl flex items-center justify-center transition-all hover:scale-105"
          title={nearTop ? "Move to bottom" : "Move to top"}
          aria-label={nearTop ? "Move to bottom" : "Move to top"}
        >
          {nearTop ? <ArrowDown size={19} /> : <ArrowUp size={19} />}
        </button>
      </main>
    </div>
  );
}
