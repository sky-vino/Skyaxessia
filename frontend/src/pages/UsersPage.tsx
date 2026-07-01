import { FormEvent, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { userApi } from "../services/api";
import { useAuth } from "../store/auth";
import { Navigate } from "react-router-dom";
import { Activity, CheckCircle2, Loader2, Plus, ShieldCheck, UserCog } from "lucide-react";

function shortId(id?: string) {
  return String(id || "").slice(0, 8).toUpperCase();
}

export default function UsersPage() {
  const { user } = useAuth();
  const qc = useQueryClient();
  const [email, setEmail] = useState("");
  const [fullName, setFullName] = useState("");
  const [password, setPassword] = useState("Accessibility");
  const [role, setRole] = useState("analyst");
  const [notice, setNotice] = useState("");
  const [passwordEdits, setPasswordEdits] = useState<Record<string, string>>({});

  const { data, isLoading } = useQuery({
    queryKey: ["users"],
    queryFn: () => userApi.list(),
  });

  const { data: auditData } = useQuery({
    queryKey: ["audit-events"],
    queryFn: () => userApi.auditEvents(),
  });

  const createMut = useMutation({
    mutationFn: () => userApi.create({ email, full_name: fullName, password, role }),
    onSuccess: () => {
      setNotice("User created");
      setEmail("");
      setFullName("");
      setPassword("Accessibility");
      setRole("analyst");
      qc.invalidateQueries({ queryKey: ["users"] });
      window.setTimeout(() => setNotice(""), 3000);
    },
  });

  const statusMut = useMutation({
    mutationFn: ({ id, is_active }: { id: string; is_active: boolean }) => userApi.patch(id, { is_active }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["users"] }),
  });

  const roleMut = useMutation({
    mutationFn: ({ id, role }: { id: string; role: string }) => userApi.patch(id, { role }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["users"] }),
  });

  const passwordMut = useMutation({
    mutationFn: ({ id, password }: { id: string; password: string }) => userApi.patch(id, { password }),
    onSuccess: (_res, vars) => {
      setPasswordEdits(current => ({ ...current, [vars.id]: "" }));
      setNotice("Password updated");
      qc.invalidateQueries({ queryKey: ["users"] });
      window.setTimeout(() => setNotice(""), 3000);
    },
  });

  const handleSubmit = (event: FormEvent) => {
    event.preventDefault();
    if (!email.trim() || !fullName.trim() || password.length < 8) return;
    createMut.mutate();
  };

  const users = data?.data?.users || [];
  const auditEvents = auditData?.data?.events || [];

  if (user?.role !== "admin") return <Navigate to="/" replace />;

  return (
    <div className="p-8 max-w-7xl mx-auto">
      <div className="flex items-start justify-between gap-4 mb-8">
        <div>
          <h1 className="text-2xl font-semibold text-slate-100">Users</h1>
          <p className="text-sm text-slate-500 mt-0.5">Create and manage accounts. Analyst users can scan, re-run scans, and open reports.</p>
        </div>
        {notice && (
          <div className="inline-flex items-center gap-2 rounded-lg px-3 py-2 text-sm text-green-400 bg-green-400/10 border border-green-400/25">
            <CheckCircle2 size={15} /> {notice}
          </div>
        )}
      </div>

      <div className="grid grid-cols-3 gap-4 mb-6">
        <div className="card p-4">
          <div className="text-sm font-semibold text-slate-200 mb-1">Admin</div>
          <p className="text-xs text-slate-500 leading-relaxed">Full access, including scan workflows, reports, projects, and user management. Admin accounts cannot be deactivated here.</p>
        </div>
        <div className="card p-4">
          <div className="text-sm font-semibold text-slate-200 mb-1">Analyst</div>
          <p className="text-xs text-slate-500 leading-relaxed">Standard user role. Can create scans, re-run scans, review results, update issue/test status, and open reports.</p>
        </div>
        <div className="card p-4">
          <div className="text-sm font-semibold text-slate-200 mb-1">Viewer</div>
          <p className="text-xs text-slate-500 leading-relaxed">Read-oriented role in the current app. Backend write restrictions are limited, so use Analyst for normal scan users.</p>
        </div>
      </div>

      <div className="grid gap-6 mb-8" style={{ gridTemplateColumns: "minmax(280px, 360px) minmax(0, 1fr)" }}>
        <form onSubmit={handleSubmit} className="card p-5 h-fit">
          <div className="flex items-center gap-2 mb-4">
            <UserCog size={17} className="text-accent" />
            <h2 className="text-base font-semibold text-slate-200">Add user</h2>
          </div>

          <label className="block mb-4">
            <span className="text-xs text-slate-500 mb-1 block">Username or email</span>
            <input value={email} onChange={event => setEmail(event.target.value)} placeholder="user6 or name@company.com" className="w-full px-3 py-2 rounded-lg text-sm outline-none" style={{ border: "1px solid var(--border-strong)" }} />
          </label>

          <label className="block mb-4">
            <span className="text-xs text-slate-500 mb-1 block">Full name</span>
            <input value={fullName} onChange={event => setFullName(event.target.value)} placeholder="User 6" className="w-full px-3 py-2 rounded-lg text-sm outline-none" style={{ border: "1px solid var(--border-strong)" }} />
          </label>

          <label className="block mb-4">
            <span className="text-xs text-slate-500 mb-1 block">Password</span>
            <input value={password} onChange={event => setPassword(event.target.value)} type="text" className="w-full px-3 py-2 rounded-lg text-sm outline-none" style={{ border: "1px solid var(--border-strong)" }} />
          </label>

          <label className="block mb-5">
            <span className="text-xs text-slate-500 mb-1 block">Role</span>
            <select value={role} onChange={event => setRole(event.target.value)} className="w-full px-3 py-2 rounded-lg text-sm outline-none" style={{ border: "1px solid var(--border-strong)" }}>
              <option value="analyst">Analyst</option>
              <option value="viewer">Viewer</option>
              <option value="admin">Admin</option>
            </select>
          </label>

          {createMut.error && (
            <div className="mb-4 rounded-lg px-3 py-2 text-xs text-red-300 bg-red-400/10 border border-red-400/25">
              {(createMut.error as any)?.response?.data?.error || "Failed to create user"}
            </div>
          )}

          <button type="submit" disabled={createMut.isPending || !email.trim() || !fullName.trim() || password.length < 8} className="sky-primary w-full flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg text-sm font-medium transition-all disabled:opacity-50 disabled:cursor-not-allowed">
            {createMut.isPending ? <Loader2 size={16} className="animate-spin" /> : <Plus size={16} />}
            Create user
          </button>
        </form>

        <div className="card overflow-hidden">
          <div className="px-5 py-4 border-b flex items-center gap-2" style={{ borderColor: "var(--border)" }}>
            <ShieldCheck size={17} className="text-accent" />
            <h2 className="text-base font-semibold text-slate-200">Current users</h2>
          </div>

          {isLoading ? (
            <div className="flex items-center justify-center py-20">
              <Loader2 size={22} className="animate-spin text-accent" />
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-xs text-slate-600 uppercase tracking-wide">
                    <th className="px-5 py-3 font-semibold">User</th>
                    <th className="px-5 py-3 font-semibold">Role</th>
                    <th className="px-5 py-3 font-semibold">Password</th>
                    <th className="px-5 py-3 font-semibold">Status</th>
                    <th className="px-5 py-3 font-semibold text-right">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {users.map((managedUser: any) => (
                    <tr key={managedUser.id} className="border-t" style={{ borderColor: "var(--border)" }}>
                      <td className="px-5 py-4">
                        <div className="font-medium text-slate-200">{managedUser.full_name}</div>
                        <div className="text-xs text-slate-600">{managedUser.email}</div>
                      </td>
                      <td className="px-5 py-4">
                        <select value={managedUser.role} onChange={event => roleMut.mutate({ id: managedUser.id, role: event.target.value })} className="px-3 py-2 rounded-lg text-xs outline-none" style={{ border: "1px solid var(--border-strong)" }}>
                          <option value="analyst">Analyst</option>
                          <option value="viewer">Viewer</option>
                          <option value="admin">Admin</option>
                        </select>
                      </td>
                      <td className="px-5 py-4">
                        <div className="flex items-center gap-2 min-w-64">
                          <input type="text" value={passwordEdits[managedUser.id] || ""} onChange={event => setPasswordEdits(current => ({ ...current, [managedUser.id]: event.target.value }))} placeholder="New password" className="w-40 px-3 py-2 rounded-lg text-xs outline-none" style={{ border: "1px solid var(--border-strong)" }} />
                          <button type="button" disabled={!passwordEdits[managedUser.id] || passwordEdits[managedUser.id].length < 8 || passwordMut.isPending} onClick={() => passwordMut.mutate({ id: managedUser.id, password: passwordEdits[managedUser.id] })} className="px-3 py-2 rounded-lg text-xs border transition-all hover:bg-white/[0.04] disabled:opacity-50 disabled:cursor-not-allowed" style={{ borderColor: "var(--border-strong)", color: "var(--text)" }}>
                            Update
                          </button>
                        </div>
                      </td>
                      <td className="px-5 py-4">
                        <span className={`inline-flex rounded-full px-2.5 py-1 text-xs font-semibold ${managedUser.is_active ? "text-green-400 bg-green-400/10" : "text-slate-500 bg-white/[0.04]"}`}>
                          {managedUser.is_active ? "Active" : "Inactive"}
                        </span>
                      </td>
                      <td className="px-5 py-4 text-right">
                        {managedUser.role === "admin" ? (
                          <span className="text-xs text-slate-600">Protected</span>
                        ) : (
                          <button type="button" onClick={() => statusMut.mutate({ id: managedUser.id, is_active: !managedUser.is_active })} className="px-3 py-2 rounded-lg text-xs border transition-all hover:bg-white/[0.04]" style={{ borderColor: "var(--border-strong)", color: "var(--text)" }}>
                            {managedUser.is_active ? "Deactivate" : "Activate"}
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>

      <div className="card p-5">
        <div className="flex items-center gap-2 mb-4">
          <Activity size={17} className="text-accent" />
          <h2 className="text-base font-semibold text-slate-200">Scan action audit</h2>
        </div>
        {auditEvents.length === 0 ? (
          <p className="text-sm text-slate-600">No scan deletions or re-runs recorded yet.</p>
        ) : (
          <div className="grid gap-2">
            {auditEvents.map((event: any) => (
              <div key={event.id} className="rounded-lg px-3 py-2 flex items-center justify-between gap-3" style={{ background: "rgba(255,255,255,0.025)", border: "1px solid var(--border)" }}>
                <div className="min-w-0">
                  <div className="text-sm text-slate-300">{event.action === "scan.delete" ? "Deleted scan" : "Re-ran scan"}: {event.entity_name || "Untitled Scan"}</div>
                  <div className="text-xs text-slate-600 font-mono truncate">ID: {shortId(event.entity_id)}</div>
                </div>
                <div className="text-right text-xs text-slate-600 flex-shrink-0">
                  <div>{event.actor_name || event.actor_email || "Unknown user"}</div>
                  <div>{new Date(event.created_at).toLocaleString()}</div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
