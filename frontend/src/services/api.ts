import axios from "axios";

export const api = axios.create({
  baseURL: (import.meta as any).env?.VITE_API_URL
    ? `${(import.meta as any).env.VITE_API_URL}/api`
    : "/api",
  withCredentials: false
});

// Re-attach token on app start
const stored = localStorage.getItem("accessibility-auth");
if (stored) {
  try {
    const { state } = JSON.parse(stored);
    if (state?.accessToken) {
      api.defaults.headers.common["Authorization"] = `Bearer ${state.accessToken}`;
    }
  } catch {}
}

function clearAuthAndRedirect() {
  localStorage.removeItem("accessibility-auth");
  delete api.defaults.headers.common["Authorization"];
  if (window.location.pathname !== "/login") {
    window.location.assign("/login");
  }
}

let refreshPromise: Promise<string> | null = null;

// Auto-refresh on 401
api.interceptors.response.use(
  r => r,
  async err => {
    const original = err.config;
    const url = String(original?.url || "");
    const isAuthRequest = url.includes("/auth/login") || url.includes("/auth/refresh");

    if (original && err.response?.status === 401 && !original._retry && !isAuthRequest) {
      original._retry = true;
      try {
        const stored = localStorage.getItem("accessibility-auth");
        const { state } = JSON.parse(stored || "{}");
        if (state?.refreshToken) {
          refreshPromise = refreshPromise || api
            .post("/auth/refresh", { refresh_token: state.refreshToken })
            .then(({ data }) => data.access_token)
            .finally(() => { refreshPromise = null; });

          const accessToken = await refreshPromise;
          api.defaults.headers.common["Authorization"] = `Bearer ${accessToken}`;
          original.headers["Authorization"] = `Bearer ${accessToken}`;
          return api(original);
        }
      } catch {
        clearAuthAndRedirect();
      }
    } else if (err.response?.status === 401 && url.includes("/auth/refresh")) {
      clearAuthAndRedirect();
    }
    return Promise.reject(err);
  }
);

export const scanApi = {
  list: (params?: any) => api.get("/scans", { params }),
  get: (id: string) => api.get(`/scans/${id}`),
  create: (data: any) => api.post("/scans", data),
  rerun: (id: string) => api.post(`/scans/${id}/rerun`),
  delete: (id: string) => api.delete(`/scans/${id}`),
  domSnapshots: (id: string) => api.get(`/scans/${id}/dom-snapshots`),
  testCases: (id: string) => api.get(`/scans/${id}/test-cases`),
  updateTestCase: (scanId: string, testCaseId: string, data: any) => api.patch(`/scans/${scanId}/test-cases/${testCaseId}`, data)
};

export const issueApi = {
  list: (params?: any) => api.get("/issues", { params }),
  get: (id: string) => api.get(`/issues/${id}`),
  aiExplain: (id: string) => api.post(`/issues/${id}/ai-explain`),
  patch: (id: string, data: any) => api.patch(`/issues/${id}`, data)
};

export const projectApi = {
  list: () => api.get("/projects"),
  create: (data: any) => api.post("/projects", data),
  delete: (id: string) => api.delete(`/projects/${id}`)
};

export const userApi = {
  list: () => api.get("/users"),
  auditEvents: () => api.get("/users/audit-events"),
  create: (data: any) => api.post("/users", data),
  patch: (id: string, data: any) => api.patch(`/users/${id}`, data)
};

export const wcagGovernanceApi = {
  status: () => api.get("/wcag-governance/status"),
  reviews: (status = "pending") => api.get("/wcag-governance/reviews", { params: { status } }),
  refresh: () => api.post("/wcag-governance/refresh"),
  updateReview: (id: string, status: string) => api.patch(`/wcag-governance/reviews/${id}`, { status })
};

export const reportApi = {
  getReport: (scanId: string, sections?: string[]) => api.get(`/scans/${scanId}/report`, {
    responseType: "text",
    params: sections?.length ? { sections: sections.join(",") } : undefined
  }),
  getReportPdf: (scanId: string, sections?: string[]) => api.get(`/scans/${scanId}/report/pdf`, {
    responseType: "blob",
    params: sections?.length ? { sections: sections.join(",") } : undefined
  }),
  getReportUrl: (scanId: string, sections?: string[]) => {
    const base = (import.meta as any).env?.VITE_API_URL
      ? `${(import.meta as any).env.VITE_API_URL}/api`
      : "/api";
    const query = sections?.length ? `?sections=${encodeURIComponent(sections.join(","))}` : "";
    return `${base}/scans/${scanId}/report${query}`;
  },
  getScreenshots: (scanId: string) => api.get(`/scans/${scanId}/screenshots`),
};
