import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "../store/auth";
import { motion } from "framer-motion";
import { Eye, EyeOff, Loader2 } from "lucide-react";

export default function LoginPage() {
  const { login } = useAuth();
  const navigate = useNavigate();
  const [email, setEmail] = useState("admin@accessibility.local");
  const [password, setPassword] = useState("Admin@123");
  const [showPw, setShowPw] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setLoading(true);
    try {
      await login(email, password);
      navigate("/");
    } catch (err: any) {
      setError(err.response?.data?.error || "Login failed. Check credentials.");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center relative overflow-hidden" style={{ background: "var(--bg)" }}>
      {/* Background grid — recoloured to Sky pink from teal */}
      <div
        className="absolute inset-0 opacity-20"
        style={{
          backgroundImage:
            "linear-gradient(rgba(224,0,98,0.10) 1px, transparent 1px), linear-gradient(90deg, rgba(224,0,98,0.10) 1px, transparent 1px)",
          backgroundSize: "60px 60px"
        }}
      />

      {/* Glow orbs — Sky gradient stops */}
      <div className="absolute top-1/4 left-1/4 w-96 h-96 rounded-full opacity-15" style={{ background: "radial-gradient(circle, #E00062, transparent)" }} />
      <div className="absolute bottom-1/4 right-1/4 w-72 h-72 rounded-full opacity-10" style={{ background: "radial-gradient(circle, #3B82F6, transparent)" }} />
      <div className="absolute top-1/2 right-1/3 w-60 h-60 rounded-full opacity-10" style={{ background: "radial-gradient(circle, #FF6B00, transparent)" }} />

      <motion.div
        initial={{ opacity: 0, y: 24 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.5, ease: "easeOut" }}
        className="relative z-10 w-full max-w-md px-6"
      >
        {/* Brand: Axessia · sky wordmark */}
        <div className="flex items-center gap-3 mb-10 justify-center">
          <div className="min-w-0">
            <div className="flex items-baseline gap-2 justify-center">
              <span
                className="text-2xl font-semibold tracking-tight"
                style={{ color: "var(--text-strong)" }}
              >
                Axessia
              </span>
              <span className="text-xs" style={{ color: "var(--muted)" }}>by</span>
              <span className="sky-wordmark text-3xl" aria-label="Sky">sky</span>
            </div>
            <div className="text-xs leading-none mt-1.5 text-center" style={{ color: "var(--muted)" }}>
              Accessibility Platform
            </div>
          </div>
        </div>

        <div className="card p-8">
          <h1 className="text-2xl font-semibold mb-1" style={{ color: "var(--text-strong)" }}>Welcome back</h1>
          <p className="text-sm mb-8" style={{ color: "var(--muted)" }}>Sign in to your workspace</p>

          <form onSubmit={handleSubmit} className="space-y-5">
            <div>
              <label className="block text-xs font-medium mb-1.5" style={{ color: "var(--muted-strong)" }} htmlFor="email">Username or email</label>
              <input
                id="email"
                type="text"
                autoComplete="username"
                value={email}
                onChange={e => setEmail(e.target.value)}
                required
                className="w-full px-4 py-3 rounded-lg text-sm outline-none transition-all"
                style={{ background: "var(--input-bg)", border: "1px solid var(--border-strong)", color: "var(--text)" }}
                onFocus={e => (e.target as HTMLInputElement).style.borderColor = "rgba(224,0,98,0.55)"}
                onBlur={e => (e.target as HTMLInputElement).style.borderColor = "rgba(255,255,255,0.08)"}
                placeholder="user1 or you@sky.uk"
              />
            </div>
            <div>
              <label className="block text-xs font-medium mb-1.5" style={{ color: "var(--muted-strong)" }} htmlFor="password">Password</label>
              <div className="relative">
                <input
                  id="password"
                  type={showPw ? "text" : "password"}
                  value={password}
                  onChange={e => setPassword(e.target.value)}
                  required
                  className="w-full px-4 py-3 pr-12 rounded-lg text-sm outline-none transition-all"
                  style={{ background: "var(--input-bg)", border: "1px solid var(--border-strong)", color: "var(--text)" }}
                  onFocus={e => (e.target as HTMLInputElement).style.borderColor = "rgba(224,0,98,0.55)"}
                  onBlur={e => (e.target as HTMLInputElement).style.borderColor = "rgba(255,255,255,0.08)"}
                />
                <button
                  type="button"
                  onClick={() => setShowPw(!showPw)}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-500 hover:text-slate-300 transition-colors"
                  aria-label={showPw ? "Hide password" : "Show password"}
                >
                  {showPw ? <EyeOff size={16} /> : <Eye size={16} />}
                </button>
              </div>
            </div>

            {error && (
              <motion.div initial={{ opacity: 0, y: -8 }} animate={{ opacity: 1, y: 0 }}
                className="text-sm text-red-400 px-4 py-3 rounded-lg"
                style={{ background: "rgba(255,77,109,0.1)", border: "1px solid rgba(255,77,109,0.2)" }}>
                {error}
              </motion.div>
            )}

            {/* Sign in button — Sky gradient */}
            <button
              type="submit"
              disabled={loading}
              className="sky-primary w-full py-3 rounded-lg text-sm font-semibold flex items-center justify-center gap-2"
              style={{ opacity: loading ? 0.7 : 1 }}
            >
              {loading ? <><Loader2 size={16} className="animate-spin" />Signing in…</> : "Sign in"}
            </button>
          </form>

          <p className="text-center text-xs mt-6" style={{ color: "var(--muted)" }}>
            Default: admin@accessibility.local / Admin@123
          </p>
        </div>

        {/* Small footer credit */}
        <div className="text-center mt-6 text-[11px]" style={{ color: "var(--muted)" }}>
          Axessia by <span className="sky-wordmark text-sm" style={{ fontSize: "13px" }}>sky</span> · Internal accessibility platform
        </div>
      </motion.div>
    </div>
  );
}
