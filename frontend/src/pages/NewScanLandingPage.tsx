import { useNavigate } from "react-router-dom";
import { motion } from "framer-motion";
import { FlaskConical, Shield, ArrowRight } from "lucide-react";

/**
 * Landing page shown when the user clicks "New Scan" in the sidebar.
 * Presents two flow choices:
 *
 *  - Stage / tst5 → routes to the existing NewScanPage form at
 *    `/scans/new/stage`. That form does automated login + auto-OTP
 *    scraping from the page (via `otp_source_selector`) and is safe
 *    for non-production environments.
 *
 *  - Production → routes to the pre-existing ProductionScanPage
 *    (`/scans/production`) which drives an interactive auth-session
 *    flow: user enters credentials → clicks "Generate OTP" → real SMS/email
 *    OTP arrives on their device → user types the OTP into the UI →
 *    "Login and Scan" completes the login inside the paused Playwright
 *    browser and hands the authenticated session off to a normal scan.
 *
 * This page carries no scan configuration state — it only routes.
 */
export default function NewScanLandingPage() {
  const navigate = useNavigate();

  const cards: Array<{
    id: "stage" | "production";
    title: string;
    subtitle: string;
    description: string;
    bullets: string[];
    to: string;
    Icon: typeof FlaskConical;
    accent: string;
    accentBg: string;
    accentBorder: string;
  }> = [
    {
      id: "stage",
      title: "Stage / Test",
      subtitle: "stage.abbonamento.sky.it, tst5",
      description: "Full automation. Scanner logs in, scrapes OTP from the page, and runs the full audit end-to-end without human input.",
      bullets: [
        "Auto-fills username + password",
        "Reads OTP from the login page automatically",
        "No human required after Launch",
        "Safe for scheduled / batched scans",
      ],
      to: "/scans/new/stage",
      Icon: FlaskConical,
      accent: "text-teal-300",
      accentBg: "rgba(15,118,110,0.08)",
      accentBorder: "rgba(15,118,110,0.4)",
    },
    {
      id: "production",
      title: "Production",
      subtitle: "abbonamento.sky.it",
      description: "Interactive. Scanner starts login, sends a real OTP to your device, waits while you type it back, then completes the scan.",
      bullets: [
        "You enter credentials + pick Email or SMS OTP",
        "Click Generate OTP — real code sent to your phone/inbox",
        "You type the OTP back into the UI",
        "Click Login and Scan — session hands off to a normal scan",
      ],
      to: "/scans/production",
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
        <h1 className="text-2xl font-semibold text-slate-100">New Scan</h1>
        <p className="text-sm text-slate-500 mt-2 leading-relaxed">
          Choose the environment you're scanning. Stage and Production have different login flows —
          Stage is fully automated; Production requires you to enter a real OTP interactively.
        </p>
      </motion.div>

      <div className="grid gap-5 md:grid-cols-2">
        {cards.map((card, idx) => {
          const Icon = card.Icon;
          return (
            <motion.button
              key={card.id}
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.05 + idx * 0.05 }}
              onClick={() => navigate(card.to)}
              className="text-left card p-6 hover:border-accent/40 transition-all group"
              style={{
                background: card.accentBg,
                border: `1px solid ${card.accentBorder}`,
                borderRadius: 14,
              }}
              aria-label={`Start a ${card.title} scan`}
            >
              <div className="flex items-start gap-4 mb-4">
                <div
                  className={`h-11 w-11 rounded-xl flex items-center justify-center ${card.accent}`}
                  style={{ background: "rgba(255,255,255,0.04)", border: `1px solid ${card.accentBorder}` }}
                >
                  <Icon size={20} />
                </div>
                <div className="flex-1 min-w-0">
                  <div className={`text-lg font-semibold ${card.accent}`}>{card.title}</div>
                  <div className="text-xs text-slate-500 mt-0.5 font-mono">{card.subtitle}</div>
                </div>
                <ArrowRight
                  size={18}
                  className="text-slate-600 group-hover:text-accent group-hover:translate-x-0.5 transition-all mt-1.5"
                />
              </div>

              <p className="text-sm text-slate-300 leading-relaxed mb-4">{card.description}</p>

              <ul className="space-y-1.5">
                {card.bullets.map((b) => (
                  <li key={b} className="text-xs text-slate-500 flex items-start gap-2">
                    <span className={`${card.accent} mt-0.5 flex-shrink-0`}>•</span>
                    <span>{b}</span>
                  </li>
                ))}
              </ul>
            </motion.button>
          );
        })}
      </div>

      <motion.p
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ delay: 0.2 }}
        className="mt-8 text-xs text-slate-600 text-center leading-relaxed"
      >
        Not sure which to pick? Stage exercises the same journey as production without triggering real user credentials or SMS.
        Use Production only when your audit needs the real production data set (real offers, real account state).
      </motion.p>
    </div>
  );
}
