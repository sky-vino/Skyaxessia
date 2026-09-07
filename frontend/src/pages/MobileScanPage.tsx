import { useNavigate } from "react-router-dom";
import { motion } from "framer-motion";
import { FlaskConical, Shield, ArrowRight, Smartphone } from "lucide-react";

/**
 * Mobile Scan landing page.
 *
 * Uses the same visual structure and styling as the Web Scan
 * NewScanLandingPage.
 *
 * Stage / Test → BrowserStack Android configuration page
 * Production → reserved for the future mobile production flow
 */
export default function MobileScanPage() {
  const navigate = useNavigate();

  const cards: Array<{
    id: "stage" | "production";
    title: string;
    subtitle: string;
    description: string;
    bullets: string[];
    Icon: typeof FlaskConical;
    accent: string;
    accentBg: string;
    accentBorder: string;
  }> = [
    {
      id: "stage",
      title: "Stage / Test",
      subtitle: "MSA Test Env",
      description:
        "Full automation. Connects to BrowserStack and runs the Android accessibility scan against the configured test application.",
      bullets: [
        "BrowserStack Android execution",
        "Enter BrowserStack configuration",
        "Enter MSA login credentials",
        "Select the Android scan flow",
      ],
      Icon: FlaskConical,
      accent: "text-teal-300",
      accentBg: "rgba(15,118,110,0.08)",
      accentBorder: "rgba(15,118,110,0.4)",
    },
    {
      id: "production",
      title: "Production",
      subtitle: "MSA Production",
      description:
        "Run an accessibility scan against the production Android application.",
      bullets: [
        "Production Android application",
        "BrowserStack execution",
        "Production authentication flow",
        "Interactive scan flow",
      ],
      Icon: Shield,
      accent: "text-rose-300",
      accentBg: "rgba(255,77,109,0.06)",
      accentBorder: "rgba(255,77,109,0.4)",
    },
  ];

  return (
    <div className="max-w-5xl mx-auto py-10 px-4">
      <motion.div
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        className="mb-8"
      >
        <h1 className="text-2xl font-semibold text-slate-100">
          Mobile Scan
        </h1>

        <p className="text-sm text-slate-500 mt-2 leading-relaxed">
          Choose the environment you're scanning. Stage and Production have
          different login flows — Stage OTP fetch is automated; Production
          requires you to enter a real OTP interactively.
        </p>
      </motion.div>

      {/* Web / Mobile scan selector */}
      <div className="flex justify-center mb-8">
        <div
          className="inline-flex rounded-xl p-1"
          style={{
            background: "var(--surface-1)",
            border: "1px solid var(--border-strong)",
            boxShadow: "0 4px 14px rgba(0,0,0,0.06)",
          }}
        >
          {/* Web Scan */}
          <button
            type="button"
            onClick={() => navigate("/scans/new")}
            className="px-6 py-2.5 rounded-lg text-sm font-semibold transition-all"
            style={{
              background: "transparent",
              color: "var(--muted-strong)",
            }}
          >
            Web Scan
          </button>

          {/* Mobile Scan - selected */}
          <button
            type="button"
            className="px-6 py-2.5 rounded-lg text-sm font-semibold transition-all"
            style={{
              background: "var(--sky-gradient)",
              color: "white",
              boxShadow: "0 4px 12px rgba(176,24,216,0.22)",
            }}
          >
            <span className="inline-flex items-center gap-1.5">
              <Smartphone size={14} />
              Mobile Scan
            </span>
          </button>
        </div>
      </div>

      {/* Mobile Stage / Test + Production cards */}
      <div className="grid gap-5 md:grid-cols-2">
        {cards.map((card, idx) => {
          const Icon = card.Icon;

          return (
            <motion.button
              key={card.id}
              type="button"
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.05 + idx * 0.05 }}
              onClick={() => {
                if (card.id === "stage") {
                  navigate("/scans/new/app/mobile/stage");
                }
              }}
              className="text-left card p-6 hover:border-accent/40 transition-all group"
              style={{
                background: card.accentBg,
                border: `1px solid ${card.accentBorder}`,
                borderRadius: 14,
              }}
              aria-label={`Start a ${card.title} mobile scan`}
            >
              <div className="flex items-start gap-4 mb-4">
                <div
                  className={`h-11 w-11 rounded-xl flex items-center justify-center ${card.accent}`}
                  style={{
                    background: "rgba(255,255,255,0.04)",
                    border: `1px solid ${card.accentBorder}`,
                  }}
                >
                  <Icon size={20} />
                </div>

                <div className="flex-1 min-w-0">
                  <div
                    className={`text-lg font-semibold ${card.accent}`}
                  >
                    {card.title}
                  </div>

                  <div className="text-xs text-slate-500 mt-0.5 font-mono">
                    {card.subtitle}
                  </div>
                </div>

                <ArrowRight
                  size={18}
                  className="text-slate-600 group-hover:text-accent group-hover:translate-x-0.5 transition-all mt-1.5"
                />
              </div>

              <p className="text-sm text-slate-300 leading-relaxed mb-4">
                {card.description}
              </p>

              <ul className="space-y-1.5">
                {card.bullets.map((b) => (
                  <li
                    key={b}
                    className="text-xs text-slate-500 flex items-start gap-2"
                  >
                    <span
                      className={`${card.accent} mt-0.5 flex-shrink-0`}
                    >
                      •
                    </span>

                    <span>{b}</span>
                  </li>
                ))}
              </ul>
            </motion.button>
          );
        })}
      </div>

      {/* Footer */}
      <motion.p
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ delay: 0.2 }}
        className="mt-8 text-xs text-slate-600 text-center leading-relaxed"
      >
        Choose Stage / Test for the automated BrowserStack Android
        accessibility scan. Production will be added as a separate flow.
      </motion.p>
    </div>
  );
}