import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "../store/auth";
import { motion } from "framer-motion";
import { Eye, EyeOff, Loader2 } from "lucide-react";

export default function LoginPage() {
  const { login } = useAuth();
  const navigate = useNavigate();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPw, setShowPw] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [emailFocused, setEmailFocused] = useState(false);
  const [pwFocused, setPwFocused] = useState(false);
  const [btnHover, setBtnHover] = useState(false);

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
    <div
      className="min-h-screen flex items-center justify-center relative overflow-hidden"
      style={{ background: "var(--bg)" }}
    >
      <div className="absolute top-[-10%] left-[-10%] w-[520px] h-[520px] rounded-full blur-3xl pointer-events-none"
        style={{ background: "radial-gradient(circle, rgba(224,0,98,0.22), transparent 60%)", opacity: 0.6 }} />
      <div className="absolute top-[15%] right-[-5%] w-[440px] h-[440px] rounded-full blur-3xl pointer-events-none"
        style={{ background: "radial-gradient(circle, rgba(139,43,217,0.22), transparent 60%)", opacity: 0.6 }} />
      <div className="absolute bottom-[-15%] left-[20%] w-[600px] h-[600px] rounded-full blur-3xl pointer-events-none"
        style={{ background: "radial-gradient(circle, rgba(22,119,255,0.20), transparent 60%)", opacity: 0.6 }} />

      <motion.div
        initial={{ opacity: 0, y: 24 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.55, ease: [0.22, 1, 0.36, 1] }}
        className="relative z-10 w-full max-w-md px-6"
      >
        <div className="flex flex-col items-center mb-8">
          <div className="w-14 h-14 rounded-2xl flex items-center justify-center mb-4"
            style={{
              background: "var(--sky-gradient)",
              boxShadow: "0 8px 32px -8px rgba(224, 0, 98, 0.5), 0 4px 16px -4px rgba(22, 119, 255, 0.35)",
            }}>
            <span className="text-white font-black text-2xl tracking-tight" style={{ fontFamily: "'DM Sans', sans-serif" }}>A</span>
          </div>
          <h2 className="sky-wordmark text-3xl mb-1" style={{ fontFamily: "'DM Sans', sans-serif" }}>Axessia</h2>
          <div className="text-[11px] uppercase tracking-[0.2em] font-medium" style={{ color: "var(--muted)" }}>
            Enterprise Accessibility Platform
          </div>
        </div>

        <div className="relative rounded-2xl p-[1.5px] overflow-hidden" style={{ background: "var(--sky-gradient)" }}>
          <div className="relative rounded-2xl p-8"
            style={{ background: "var(--surface-1)", backdropFilter: "blur(16px)", WebkitBackdropFilter: "blur(16px)" }}>
            <h1 className="text-2xl font-semibold mb-1" style={{ color: "var(--text-strong)" }}>Welcome back</h1>
            <p className="text-sm mb-8" style={{ color: "var(--muted)" }}>Sign in to your workspace</p>

            <form onSubmit={handleSubmit} className="space-y-5">
              <div>
                <label htmlFor="email" className="block text-[11px] font-semibold uppercase tracking-wider mb-2"
                  style={{ color: "var(--muted-strong)" }}>Username or email</label>
                <div className="rounded-xl p-[1.5px] transition-all"
                  style={{
                    background: emailFocused ? "var(--sky-gradient)" : "var(--border-strong)",
                    boxShadow: emailFocused ? "0 0 0 3px rgba(224, 0, 98, 0.12), 0 0 20px -4px rgba(139, 43, 217, 0.3)" : "none",
                  }}>
                  <input id="email" type="text" autoComplete="username" value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    onFocus={() => setEmailFocused(true)} onBlur={() => setEmailFocused(false)}
                    required className="w-full px-4 py-3.5 rounded-[10px] text-sm outline-none border-0"
                    placeholder="you@company.com" />
                </div>
              </div>

              <div>
                <label htmlFor="password" className="block text-[11px] font-semibold uppercase tracking-wider mb-2"
                  style={{ color: "var(--muted-strong)" }}>Password</label>
                <div className="relative rounded-xl p-[1.5px] transition-all"
                  style={{
                    background: pwFocused ? "var(--sky-gradient)" : "var(--border-strong)",
                    boxShadow: pwFocused ? "0 0 0 3px rgba(224, 0, 98, 0.12), 0 0 20px -4px rgba(139, 43, 217, 0.3)" : "none",
                  }}>
                  <input id="password" type={showPw ? "text" : "password"} value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    onFocus={() => setPwFocused(true)} onBlur={() => setPwFocused(false)}
                    required className="w-full px-4 py-3.5 pr-12 rounded-[10px] text-sm outline-none border-0"
                    placeholder="••••••••" />
                  <button type="button" onClick={() => setShowPw(!showPw)}
                    aria-label={showPw ? "Hide password" : "Show password"}
                    className="absolute right-3 top-1/2 -translate-y-1/2 transition-colors p-1"
                    style={{ color: "var(--muted)" }}>
                    {showPw ? <EyeOff size={17} /> : <Eye size={17} />}
                  </button>
                </div>
              </div>

              {error && (
                <motion.div initial={{ opacity: 0, y: -8 }} animate={{ opacity: 1, y: 0 }}
                  className="text-sm px-4 py-3 rounded-xl"
                  style={{ color: "#ff6b8b", background: "rgba(255,77,109,0.08)", border: "1px solid rgba(255,77,109,0.25)" }}>
                  {error}
                </motion.div>
              )}

              <button type="submit" disabled={loading}
                onMouseEnter={() => setBtnHover(true)} onMouseLeave={() => setBtnHover(false)}
                className="sky-primary relative w-full py-3.5 rounded-xl text-sm font-semibold text-white flex items-center justify-center gap-2 transition-all overflow-hidden"
                style={{
                  boxShadow: loading ? "0 8px 20px rgba(176, 24, 216, 0.18)"
                    : btnHover ? "0 12px 32px rgba(176, 24, 216, 0.35), 0 4px 16px rgba(22, 119, 255, 0.25)"
                    : "0 8px 20px rgba(176, 24, 216, 0.18)",
                  opacity: loading ? 0.7 : 1,
                  cursor: loading ? "wait" : "pointer",
                  transform: btnHover && !loading ? "translateY(-1px)" : "translateY(0)",
                  transition: "box-shadow 300ms ease, transform 200ms ease, opacity 200ms",
                }}>
                {loading ? (<><Loader2 size={16} className="animate-spin" />Signing in…</>) : "Sign in"}
              </button>
            </form>
          </div>
        </div>

        <p className="text-center text-[11px] mt-6" style={{ color: "var(--muted)" }}>
          Protected workspace · Enterprise SSO
        </p>
      </motion.div>
    </div>
  );
}
