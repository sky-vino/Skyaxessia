import HistoryTab from "../components/tabs/HistoryTab";

export default function HistoryPage() {
  return (
    <div className="p-8 max-w-7xl mx-auto">
      <div className="mb-6">
        <h1 className="text-2xl font-semibold text-slate-100">Scan History</h1>
        <p className="text-sm text-slate-500 mt-0.5">Track score movement and completed scan results over time.</p>
      </div>
      <HistoryTab />
    </div>
  );
}

