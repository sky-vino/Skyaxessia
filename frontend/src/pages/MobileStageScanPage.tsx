import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { api } from "../services/api";
import { motion } from "framer-motion";
import {
  ChevronLeft,
  Smartphone,
  KeyRound,
  Radio,
} from "lucide-react";

type ScanFlow = "Home" | "Gestici" | "Offerte" | "Guida TV";

export default function MobileStageScanPage() {
  const navigate = useNavigate();

  const [browserStackUsername, setBrowserStackUsername] = useState("");
  const [browserStackAccessKey, setBrowserStackAccessKey] = useState("");
  const [browserStackLocalIdentifier, setBrowserStackLocalIdentifier] =
    useState("");
  const [browserStackAppId, setBrowserStackAppId] = useState("");

  const [appUsername, setAppUsername] = useState("");
  const [appPassword, setAppPassword] = useState("");

  const [flow, setFlow] = useState<ScanFlow>("Home");

  const [focusedField, setFocusedField] = useState<string | null>(null);

  const [deviceModel, setDeviceModel] = useState("Samsung Galaxy S23");

  const [androidVersion, setAndroidVersion] = useState("13.0");

  const [starting, setStarting] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  const handleStartScan = async (e: React.FormEvent) => {
    e.preventDefault();

    setStarting(true);
    setMessage("");
    setError("");

    try {
      const response = await api.post("/mobile-scans/browserstack", {
        browserStackUsername,
        browserStackAccessKey,
        browserStackLocalIdentifier,
        browserStackAppId,
        deviceModel,
        androidVersion,
        appUsername,
        appPassword,
        flow,
      });

      console.log("Mobile BrowserStack scan result:", response.data);

      setMessage("Mobile BrowserStack scan completed successfully.");
    } catch (error: any) {
      console.error("Mobile BrowserStack scan failed:", error);

      setError(
        error?.response?.data?.message ||
          error?.message ||
          "Mobile BrowserStack scan failed."
      );
    } finally {
      setStarting(false);
    }
  };

  return (
    <div className="max-w-3xl mx-auto p-6 space-y-5 relative">
      {/* Background glow - same style as Web Stage / Production */}
      <div
        className="fixed top-0 right-0 w-[500px] h-[500px] rounded-full opacity-[0.10] blur-3xl pointer-events-none"
        style={{
          background:
            "radial-gradient(circle, rgba(224,0,98,0.5), transparent 60%)",
        }}
      />

      <div
        className="fixed bottom-0 left-0 w-[500px] h-[500px] rounded-full opacity-[0.10] blur-3xl pointer-events-none"
        style={{
          background:
            "radial-gradient(circle, rgba(22,119,255,0.5), transparent 60%)",
        }}
      />

      {/* Back */}
      <button
        type="button"
        onClick={() => navigate("/scans/new/app/mobile")}
        className="text-xs flex items-center gap-1 transition-colors relative z-10"
        style={{ color: "var(--muted)" }}
        onMouseEnter={(e) =>
          (e.currentTarget.style.color = "var(--text-strong)")
        }
        onMouseLeave={(e) =>
          (e.currentTarget.style.color = "var(--muted)")
        }
      >
        <ChevronLeft size={14} />
        Back to Mobile Scan
      </button>

      {/* Header */}
      <GradientCard delay={0}>
        <div className="flex items-start gap-4">
          <div
            className="w-12 h-12 rounded-xl flex items-center justify-center flex-shrink-0"
            style={{
              background: "var(--sky-gradient)",
              boxShadow: "0 8px 24px -6px rgba(176,24,216,0.35)",
            }}
          >
            <Smartphone size={22} className="text-white" />
          </div>

          <div>
            <h1
              className="text-xl font-semibold mb-1"
              style={{
                color: "var(--text-strong)",
                fontFamily: "'DM Sans', sans-serif",
              }}
            >
              Android Stage Accessibility Scan
            </h1>

            <p
              className="text-xs leading-relaxed"
              style={{ color: "var(--muted)" }}
            >
              Configure the BrowserStack Android test environment and
              credentials for the accessibility scan. The selected flow will
              determine which part of the Android application is scanned.
            </p>
          </div>
        </div>
      </GradientCard>

      <form onSubmit={handleStartScan} className="space-y-5">
        {/* BrowserStack Configuration */}
        <GradientCard delay={0.04}>
          <SectionHeader label="BrowserStack Configuration" />

          <div className="space-y-5">
            <PremiumInput
              label="BrowserStack Username"
              hint="Your BrowserStack account username."
              value={browserStackUsername}
              onChange={setBrowserStackUsername}
              placeholder="BrowserStack username"
              type="text"
              autoComplete="off"
              focused={focusedField === "bs_username"}
              onFocus={() => setFocusedField("bs_username")}
              onBlur={() => setFocusedField(null)}
            />

            <PremiumInput
              label="BrowserStack Access Key"
              hint="Your BrowserStack access key."
              value={browserStackAccessKey}
              onChange={setBrowserStackAccessKey}
              placeholder="••••••••••••••••"
              type="password"
              autoComplete="new-password"
              focused={focusedField === "bs_access_key"}
              onFocus={() => setFocusedField("bs_access_key")}
              onBlur={() => setFocusedField(null)}
            />

            <PremiumInput
              label="BrowserStack Local Identifier"
              hint="The Local Identifier used by the BrowserStack Local connection."
              value={browserStackLocalIdentifier}
              onChange={setBrowserStackLocalIdentifier}
              placeholder="••••••••••••••••"
              type="text"
              autoComplete="off"
              focused={focusedField === "bs_local_identifier"}
              onFocus={() => setFocusedField("bs_local_identifier")}
              onBlur={() => setFocusedField(null)}
            />

            <PremiumInput
              label="BrowserStack App ID"
              hint="The uploaded Android application identifier from BrowserStack."
              value={browserStackAppId}
              onChange={setBrowserStackAppId}
              placeholder="e.g. bs://xxxxxxxxxxxxxxxx"
              type="text"
              autoComplete="off"
              focused={focusedField === "bs_app_id"}
              onFocus={() => setFocusedField("bs_app_id")}
              onBlur={() => setFocusedField(null)}
            />
          </div>
          <div>
            <FieldLabel>Device Model</FieldLabel>

            <div
              className="relative rounded-xl p-[1.5px]"
              style={{
                background: "var(--border-strong)",
              }}
            >
              <select
                value={deviceModel}
                onChange={(e) => setDeviceModel(e.target.value)}
                className="w-full px-4 py-3.5 rounded-[10px] text-sm outline-none border-0 appearance-none"
                style={{
                  background: "var(--input-bg)",
                  color: "var(--text-strong)",
                }}
              >
                <option value="Samsung Galaxy S23">
                  Samsung Galaxy S23
                </option>
              </select>
            </div>

            <div
              className="text-[10px] mt-2 ml-1 leading-relaxed"
              style={{ color: "var(--muted)" }}
            >
              BrowserStack Android device model.
            </div>
          </div>

          <div>
            <FieldLabel>Android Version</FieldLabel>

            <div
              className="relative rounded-xl p-[1.5px]"
              style={{
                background: "var(--border-strong)",
              }}
            >
              <select
                value={androidVersion}
                onChange={(e) => setAndroidVersion(e.target.value)}
                className="w-full px-4 py-3.5 rounded-[10px] text-sm outline-none border-0 appearance-none"
                style={{
                  background: "var(--input-bg)",
                  color: "var(--text-strong)",
                }}
              >
                <option value="13.0">13.0</option>
              </select>
            </div>

            <div
              className="text-[10px] mt-2 ml-1 leading-relaxed"
              style={{ color: "var(--muted)" }}
            >
              Android OS version for the BrowserStack device.
            </div>
          </div>
        </GradientCard>

        {/* Android Application Login */}
        <GradientCard delay={0.06}>
          <SectionHeader label="MSA Login" />

          <div className="space-y-5">
            <PremiumInput
              label="MSA Login Username"
              hint="Username used to log in to the MSA application."
              value={appUsername}
              onChange={setAppUsername}
              placeholder="user@example.com"
              type="text"
              autoComplete="off"
              focused={focusedField === "app_username"}
              onFocus={() => setFocusedField("app_username")}
              onBlur={() => setFocusedField(null)}
            />

            <PremiumInput
              label="MSA Login Password"
              hint="Password used to log in to the MSA application."
              value={appPassword}
              onChange={setAppPassword}
              placeholder="••••••••"
              type="password"
              autoComplete="new-password"
              focused={focusedField === "app_password"}
              onFocus={() => setFocusedField("app_password")}
              onBlur={() => setFocusedField(null)}
            />
          </div>
        </GradientCard>

        {/* Scan Flow */}
        <GradientCard delay={0.08}>
          <SectionHeader label="Scan Flow" />

          <div
            className="rounded-xl p-4"
            style={{
              background: "var(--surface-1)",
              border: "1px solid var(--border-strong)",
            }}
          >
            <div className="flex items-center gap-2 mb-4">
              <Radio size={15} style={{ color: "var(--sky-pink)" }} />

              <span
                className="text-xs"
                style={{ color: "var(--muted)" }}
              >
                Select the Android application area to scan.
              </span>
            </div>

            <div className="grid grid-cols-2 gap-3">
              {(
                ["Home", "Gestici", "Offerte", "Guida TV"] as ScanFlow[]
              ).map((option) => (
                <button
                  key={option}
                  type="button"
                  onClick={() => setFlow(option)}
                  className="text-left rounded-xl p-4 transition-all relative overflow-hidden"
                  style={{
                    background:
                      flow === option
                        ? "rgba(224, 0, 98, 0.06)"
                        : "var(--surface-2)",
                    border:
                      flow === option
                        ? "1.5px solid var(--sky-pink)"
                        : "1.5px solid var(--border-strong)",
                    boxShadow:
                      flow === option
                        ? "0 0 0 3px rgba(224, 0, 98, 0.08)"
                        : "none",
                  }}
                >
                  <div
                    className="text-sm font-semibold mb-1"
                    style={{
                      color:
                        flow === option
                          ? "var(--sky-pink)"
                          : "var(--text-strong)",
                    }}
                  >
                    {option}
                  </div>

                  <div
                    className="text-[11px] leading-relaxed"
                    style={{ color: "var(--muted)" }}
                  >
                    {option === "Home"
                      ? "Scan the Android Home page."
                      : option === "Gestici"
                        ? "Scan the Gestici area."
                        : option === "Offerte"
                          ? "Scan the Offerte area."
                          : "Scan the Guida TV area."}
                  </div>
                </button>
              ))}
            </div>
          </div>
        </GradientCard>

        {/* Selected Flow */}
        <GradientCard delay={0.10}>
          <SectionHeader label="Scan Summary" />

          <div
            className="rounded-xl p-4"
            style={{
              background: "var(--surface-1)",
              border: "1px solid var(--border-strong)",
            }}
          >
            <div className="flex items-center justify-between">
              <div>
                <div
                  className="text-[10px] uppercase tracking-wider mb-1"
                  style={{ color: "var(--muted-strong)" }}
                >
                  Selected Android Flow
                </div>

                <div
                  className="text-sm font-semibold"
                  style={{ color: "var(--text-strong)" }}
                >
                  {flow}
                </div>
              </div>

              <div
                className="w-10 h-10 rounded-xl flex items-center justify-center"
                style={{
                  background: "rgba(224,0,98,0.08)",
                  border: "1px solid rgba(224,0,98,0.25)",
                }}
              >
                <Smartphone
                  size={18}
                  style={{ color: "var(--sky-pink)" }}
                />
              </div>
            </div>
          </div>
        </GradientCard>

        {/* Start Scan */}
        <div className="flex justify-end pt-1">
          <button
            type="submit"
            disabled={starting}
            className="inline-flex items-center gap-2 px-6 py-3 rounded-xl font-semibold text-sm text-white transition-all disabled:opacity-60 disabled:cursor-not-allowed"
            style={{
              background: "var(--sky-gradient)",
              boxShadow:
                "0 8px 20px rgba(176,24,216,0.18)",
            }}
            onMouseEnter={(e) => {
              if (!starting) {
                e.currentTarget.style.boxShadow =
                  "0 12px 32px rgba(176, 24, 216, 0.35), 0 4px 16px rgba(22, 119, 255, 0.25)";
              }
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.boxShadow =
                "0 8px 20px rgba(176,24,216,0.18)";
            }}
          >
            {starting ? (
              <>
                <span className="inline-block w-4 h-4 border-2 border-white/40 border-t-white rounded-full animate-spin" />
                Scanning...
              </>
            ) : (
              <>
                <KeyRound size={16} />
                Start Scan
              </>
            )}
          </button>
        </div>
      {starting && (
        <div
          className="rounded-xl px-4 py-3 flex items-center gap-3"
          style={{
            background: "rgba(59,130,246,0.08)",
            border: "1px solid rgba(59,130,246,0.25)",
            color: "var(--text-strong)",
          }}
        >
          <span className="inline-block w-5 h-5 border-2 border-current/30 border-t-current rounded-full animate-spin" />

          <div>
            <div className="text-sm font-semibold">
              Mobile scan is running...
            </div>

            <div
              className="text-xs mt-1"
              style={{ color: "var(--muted)" }}
            >
              BrowserStack is executing the Android accessibility scan.
            </div>
          </div>
        </div>
      )}

      {message && !starting && (
        <div
          className="rounded-xl px-4 py-3"
          style={{
            background: "rgba(34,197,94,0.08)",
            border: "1px solid rgba(34,197,94,0.25)",
            color: "rgb(22,163,74)",
          }}
        >
          <div className="text-sm font-semibold">
            ✓ Scan completed successfully
          </div>

          <div className="text-xs mt-1">
            Mobile BrowserStack scan completed successfully.
          </div>
        </div>
      )}

      {error && !starting && (
        <div
          className="rounded-xl px-4 py-3"
          style={{
            background: "rgba(239,68,68,0.08)",
            border: "1px solid rgba(239,68,68,0.25)",
            color: "rgb(220,38,38)",
          }}
        >
          <div className="text-sm font-semibold">
            Scan failed
          </div>

          <div className="text-xs mt-1">
            {error}
          </div>
        </div>
      )}
      </form>
    </div>
  );
}

/* =============================================================================
   Shared styling components
   Same visual language as Web Stage / Production pages
============================================================================= */

function GradientCard({
  children,
  delay = 0,
}: {
  children: React.ReactNode;
  delay?: number;
}) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{
        delay,
        duration: 0.5,
        ease: [0.22, 1, 0.36, 1],
      }}
      className="relative rounded-2xl overflow-hidden"
      style={{
        background: "var(--surface-1)",
        border: "1px solid var(--border-strong)",
      }}
    >
      <div
        className="absolute top-0 left-0 right-0 h-[2px]"
        style={{ background: "var(--sky-gradient)" }}
      />

      <div className="p-6">{children}</div>
    </motion.div>
  );
}

function SectionHeader({
  label,
  required,
}: {
  label: string;
  required?: boolean;
}) {
  return (
    <div className="flex items-center gap-2 mb-5">
      <div
        className="w-1 h-4 rounded-full"
        style={{ background: "var(--sky-gradient)" }}
      />

      <h2
        className="text-sm font-semibold tracking-wide"
        style={{
          color: "var(--text-strong)",
          fontFamily: "'DM Sans', sans-serif",
        }}
      >
        {label}

        {required && (
          <span
            className="ml-1"
            style={{ color: "var(--sky-pink)" }}
          >
            *
          </span>
        )}
      </h2>
    </div>
  );
}

function FieldLabel({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <label
      className="block text-[11px] font-semibold uppercase tracking-wider mb-2"
      style={{ color: "var(--muted-strong)" }}
    >
      {children}
    </label>
  );
}

function PremiumInput({
  label,
  hint,
  value,
  onChange,
  placeholder,
  type = "text",
  autoComplete,
  focused,
  onFocus,
  onBlur,
}: {
  label: string;
  hint?: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  type?: string;
  autoComplete?: string;
  focused: boolean;
  onFocus: () => void;
  onBlur: () => void;
}) {
  return (
    <div>
      <FieldLabel>{label}</FieldLabel>

      <div
        className="relative rounded-xl p-[1.5px] transition-all"
        style={{
          background: focused
            ? "var(--sky-pink)"
            : "var(--border-strong)",
          boxShadow: focused
            ? "0 0 0 3px rgba(224, 0, 98, 0.10)"
            : "none",
        }}
      >
        <input
          type={type}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onFocus={onFocus}
          onBlur={onBlur}
          placeholder={placeholder}
          autoComplete={autoComplete}
          className="w-full px-4 py-3.5 rounded-[10px] text-sm outline-none border-0"
          style={{
            background: "var(--input-bg)",
            color: "var(--text-strong)",
          }}
        />
      </div>

      {hint && (
        <div
          className="text-[10px] mt-2 ml-1 leading-relaxed"
          style={{ color: "var(--muted)" }}
        >
          {hint}
        </div>
      )}
    </div>
  );
}