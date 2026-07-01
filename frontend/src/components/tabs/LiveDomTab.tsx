import { motion } from "framer-motion";
import { Construction, Sparkles, Camera, Trees } from "lucide-react";

export default function LiveDomTab({ scanId }: { scanId: string }) {
  return (
    <div className="min-h-[60vh] p-8 flex items-center justify-center">
      <motion.div
        initial={{ opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        className="card max-w-2xl w-full p-8 text-center"
        style={{ background: "var(--surface-1)", border: "1px solid var(--border-strong)" }}
      >
        <div
          className="mx-auto mb-5 h-16 w-16 rounded-2xl flex items-center justify-center text-3xl"
          style={{ background: "var(--surface-2)", border: "1px solid var(--border)", color: "var(--muted-strong)" }}
          aria-hidden="true"
        >
          🛠️
        </div>
        <h2 className="text-xl font-semibold mb-2" style={{ color: "var(--text-strong)" }}>
          Live DOM is a work in progress ✨
        </h2>
        <p className="text-sm leading-relaxed mx-auto max-w-xl" style={{ color: "var(--muted-strong)" }}>
          This area is being kept light for now while the Live DOM and accessibility-tree evidence is refined. Use Issues, UI States, and Test Cases for current review, and come back here later for richer DOM-level evidence. 🌱
        </p>
        <div className="grid gap-3 mt-6" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))" }}>
          <div className="rounded-xl p-4" style={{ background: "var(--surface-2)", border: "1px solid var(--border)" }}>
            <Trees size={18} className="mx-auto mb-2" style={{ color: "var(--muted-strong)" }} />
            <div className="text-xs font-semibold" style={{ color: "var(--text-strong)" }}>A11y tree 🌳</div>
            <div className="text-[11px] mt-1" style={{ color: "var(--muted)" }}>Coming soon</div>
          </div>
          <div className="rounded-xl p-4" style={{ background: "var(--surface-2)", border: "1px solid var(--border)" }}>
            <Camera size={18} className="mx-auto mb-2" style={{ color: "var(--muted-strong)" }} />
            <div className="text-xs font-semibold" style={{ color: "var(--text-strong)" }}>State screenshots 📸</div>
            <div className="text-[11px] mt-1" style={{ color: "var(--muted)" }}>Being improved</div>
          </div>
          <div className="rounded-xl p-4" style={{ background: "var(--surface-2)", border: "1px solid var(--border)" }}>
            <Sparkles size={18} className="mx-auto mb-2" style={{ color: "var(--muted-strong)" }} />
            <div className="text-xs font-semibold" style={{ color: "var(--text-strong)" }}>Cleaner evidence ✨</div>
            <div className="text-[11px] mt-1" style={{ color: "var(--muted)" }}>Planned next</div>
          </div>
        </div>
        <div className="mt-5 inline-flex items-center gap-2 rounded-full px-3 py-1 text-[11px]" style={{ background: "var(--surface-2)", color: "var(--muted)", border: "1px solid var(--border)" }}>
          <Construction size={13} />
          <span>Paused for now · Scan ID: {scanId}</span>
        </div>
      </motion.div>
    </div>
  );
}
