/* =========================================
   PostureGuard — Frontend Application
   Shared API client + UX/session flow guard

   Notes:
   - ใช้เป็นไฟล์กลางของทุกหน้า
   - ต้องโหลดก่อน JS เฉพาะหน้าเสมอ
   - ไม่มี Calibration / Baseline
   - realtime mode ใช้ planned_duration_minutes = 0
   - เพิ่ม API helper สำหรับ LINE multi-user binding
========================================= */

(function () {
    "use strict";

    if (window.__postureGuardLoaded) return;
    window.__postureGuardLoaded = true;

    const API_BASE =
        window.location.hostname === "localhost" || window.location.hostname === "127.0.0.1"
            ? "http://127.0.0.1:8000"
            : `http://${window.location.hostname}:8000`;

    const STORAGE_KEYS = {
        currentUser: "currentUser",
        currentSessionId: "currentSessionId",
        plannedMinutes: "plannedMinutes",
        lastSessionId: "lastSessionId",
        lastSessionSummary: "lastSessionSummary",
        monitoringSessionActive: "monitoringSessionActive",
    };

    /* =========================
       API Client
    ========================= */

    async function apiRequest(method, path, body = null) {
        const options = {
            method,
            headers: {
                "Content-Type": "application/json",
            },
        };

        if (body !== null && body !== undefined) {
            options.body = JSON.stringify(body);
        }

        let response;

        try {
            response = await fetch(API_BASE + path, options);
        } catch (_) {
            throw new Error("ไม่สามารถเชื่อมต่อ backend ได้ — โปรดตรวจสอบว่า server เปิดอยู่");
        }

        let data = null;
        const contentType = response.headers.get("content-type") || "";

        if (contentType.includes("application/json")) {
            try {
                data = await response.json();
            } catch (_) {
                data = null;
            }
        }

        if (!response.ok) {
            const detail = data?.detail;
            const message = typeof detail === "string"
                ? detail
                : detail?.message || `Error ${response.status}`;

            throw new Error(message);
        }

        return data;
    }

    window.api = {
        register(username, password, fullName = "") {
            return apiRequest("POST", "/auth/register", {
                username,
                password,
                full_name: fullName,
            });
        },

        login(username, password) {
            return apiRequest("POST", "/auth/login", {
                username,
                password,
            }).then((res) => res.user);
        },

        health() {
            return apiRequest("GET", "/");
        },

        startCamera() {
            return apiRequest("POST", "/camera/start");
        },

        stopCamera() {
            return apiRequest("POST", "/camera/stop");
        },

        getCurrentPosture() {
            return apiRequest("GET", "/posture/current");
        },

        startSession(userId, plannedMinutes = 0) {
            return apiRequest("POST", "/session/start", {
                user_id: userId,
                planned_duration_minutes: plannedMinutes,
            });
        },

        stopSession() {
            return apiRequest("POST", "/session/stop");
        },

        getSessionSummary() {
            return apiRequest("GET", "/session/summary");
        },

        getHistory(userId, limit = 50) {
            return apiRequest("GET", `/history/sessions/${userId}?limit=${limit}`);
        },

        getSessionLogs(sessionId) {
            return apiRequest("GET", `/history/session/${sessionId}/logs`);
        },

        videoFrameUrl() {
            return `${API_BASE}/video/frame?t=${Date.now()}`;
        },

        /* =========================
           LINE Notification API
        ========================= */

        getLineStatus(userId = null) {
            const query = userId ? `?user_id=${encodeURIComponent(userId)}` : "";
            return apiRequest("GET", `/notification/line/status${query}`);
        },

        createLineLinkCode(userId) {
            return apiRequest("POST", "/notification/line/link-code", {
                user_id: userId,
            });
        },

        setLineEnabled(userId, enabled) {
            const payload = userId
                ? {
                    user_id: userId,
                    enabled: Boolean(enabled),
                }
                : {
                    enabled: Boolean(enabled),
                };

            return apiRequest("POST", "/notification/line/enabled", payload);
        },

        testLineNotification(userId) {
            const payload = userId
                ? { user_id: userId }
                : {};

            return apiRequest("POST", "/notification/test-line", payload);
        },
    };

    /* =========================
       Storage / Navigation
    ========================= */

    function getCurrentPage() {
        return window.location.pathname.split("/").pop() || "login.html";
    }

    function redirectTo(page, options = {}) {
        const replace = options.replace !== false;

        if (!page || getCurrentPage() === page) {
            return;
        }

        if (replace) {
            window.location.replace(page);
        } else {
            window.location.href = page;
        }
    }

    function getCurrentUser() {
        const raw = localStorage.getItem(STORAGE_KEYS.currentUser);
        if (!raw) return null;

        try {
            return JSON.parse(raw);
        } catch (_) {
            localStorage.removeItem(STORAGE_KEYS.currentUser);
            return null;
        }
    }

    function getCurrentUserId() {
        const user = getCurrentUser();

        if (!user) {
            return null;
        }

        const rawId = user.id ?? user.user_id ?? user.userId;
        const userId = Number(rawId);

        return Number.isInteger(userId) && userId > 0 ? userId : null;
    }

    function isAuthenticated() {
        return Boolean(getCurrentUser());
    }

    function isMonitoringSessionActive() {
        return (
            localStorage.getItem(STORAGE_KEYS.monitoringSessionActive) === "true" ||
            Boolean(localStorage.getItem(STORAGE_KEYS.currentSessionId))
        );
    }

    function markMonitoringSessionStarted(sessionId = null) {
        if (sessionId !== null && sessionId !== undefined) {
            localStorage.setItem(STORAGE_KEYS.currentSessionId, String(sessionId));
        }

        localStorage.setItem(STORAGE_KEYS.monitoringSessionActive, "true");
        localStorage.setItem(STORAGE_KEYS.plannedMinutes, "0");
        localStorage.removeItem(STORAGE_KEYS.lastSessionSummary);
    }

    function markMonitoringSessionStopped(summary = null) {
        const sessionId = localStorage.getItem(STORAGE_KEYS.currentSessionId);

        if (sessionId) {
            localStorage.setItem(STORAGE_KEYS.lastSessionId, sessionId);
        }

        if (summary) {
            try {
                localStorage.setItem(STORAGE_KEYS.lastSessionSummary, JSON.stringify(summary));
            } catch (err) {
                console.warn("Cannot cache last session summary:", err);
            }
        }

        localStorage.removeItem(STORAGE_KEYS.currentSessionId);
        localStorage.removeItem(STORAGE_KEYS.monitoringSessionActive);
        localStorage.removeItem(STORAGE_KEYS.plannedMinutes);
    }

    function clearSessionFlowState(options = {}) {
        const keepLast = options.keepLast === true;

        localStorage.removeItem(STORAGE_KEYS.currentSessionId);
        localStorage.removeItem(STORAGE_KEYS.monitoringSessionActive);
        localStorage.removeItem(STORAGE_KEYS.plannedMinutes);

        if (!keepLast) {
            localStorage.removeItem(STORAGE_KEYS.lastSessionId);
            localStorage.removeItem(STORAGE_KEYS.lastSessionSummary);
        }
    }

    function getLastSessionSummary() {
        const raw = localStorage.getItem(STORAGE_KEYS.lastSessionSummary);
        if (!raw) return null;

        try {
            return JSON.parse(raw);
        } catch (_) {
            localStorage.removeItem(STORAGE_KEYS.lastSessionSummary);
            return null;
        }
    }

    /* =========================
       Backend Session Guard
    ========================= */

    async function getBackendSessionStatus() {
        try {
            const summary = await window.api.getSessionSummary();

            if (summary?.session_active === true) {
                localStorage.setItem(STORAGE_KEYS.monitoringSessionActive, "true");

                return {
                    status: "active",
                    summary,
                    error: null,
                };
            }

            clearSessionFlowState({ keepLast: true });

            return {
                status: "inactive",
                summary,
                error: null,
            };
        } catch (err) {
            console.warn("Cannot check backend session:", err);

            return {
                status: "unknown",
                summary: null,
                error: err,
            };
        }
    }

    function requireAuth() {
        const user = getCurrentUser();

        if (!user) {
            redirectTo("login.html", { replace: true });
            return null;
        }

        return user;
    }

    async function redirectAuthenticatedAwayFromAuthPage() {
        if (!isAuthenticated()) {
            return true;
        }

        const hadLocalActiveSession = isMonitoringSessionActive();
        const session = await getBackendSessionStatus();

        if (
            session.status === "active" ||
            (session.status === "unknown" && hadLocalActiveSession)
        ) {
            redirectTo("monitoring.html", { replace: true });
            return false;
        }

        redirectTo("setup.html", { replace: true });
        return false;
    }

    async function requireNoActiveMonitoring() {
        const user = requireAuth();
        if (!user) return false;

        const hadLocalActiveSession = isMonitoringSessionActive();
        const session = await getBackendSessionStatus();

        if (
            session.status === "active" ||
            (session.status === "unknown" && hadLocalActiveSession)
        ) {
            redirectTo("monitoring.html", { replace: true });
            return false;
        }

        return true;
    }

    async function requireActiveMonitoringSession() {
        const user = requireAuth();
        if (!user) return false;

        const hadLocalActiveSession = isMonitoringSessionActive();
        const session = await getBackendSessionStatus();

        if (session.status === "active") {
            return true;
        }

        if (session.status === "unknown" && hadLocalActiveSession) {
            return true;
        }

        if (getLastSessionSummary() || localStorage.getItem(STORAGE_KEYS.lastSessionId)) {
            redirectTo("summary.html", { replace: true });
        } else {
            redirectTo("setup.html", { replace: true });
        }

        return false;
    }

    async function requireSummaryAccess() {
        const user = requireAuth();
        if (!user) return false;

        const hadLocalActiveSession = isMonitoringSessionActive();
        const session = await getBackendSessionStatus();

        if (
            session.status === "active" ||
            (session.status === "unknown" && hadLocalActiveSession)
        ) {
            redirectTo("monitoring.html", { replace: true });
            return false;
        }

        return true;
    }

    async function requireHistoryAccess() {
        return requireSummaryAccess();
    }

    async function enforceCurrentPageFlow() {
        const page = getCurrentPage();

        if (page === "login.html" || page === "register.html") {
            await redirectAuthenticatedAwayFromAuthPage();
            return;
        }

        if (page === "setup.html") {
            await requireNoActiveMonitoring();
            return;
        }

        if (page === "monitoring.html") {
            await requireActiveMonitoringSession();
            return;
        }

        if (page === "summary.html") {
            await requireSummaryAccess();
            return;
        }

        if (page === "history.html") {
            await requireHistoryAccess();
        }
    }

    function installBrowserHistoryGuard() {
        window.addEventListener("pageshow", (event) => {
            if (event.persisted) {
                enforceCurrentPageFlow();
            }
        });

        window.addEventListener("popstate", () => {
            enforceCurrentPageFlow();
        });
    }

    function logout() {
        if (isMonitoringSessionActive()) {
            redirectTo("monitoring.html", { replace: true });
            return;
        }

        localStorage.removeItem(STORAGE_KEYS.currentUser);
        clearSessionFlowState({ keepLast: false });
        redirectTo("login.html", { replace: true });
    }

    window.utils = {
        API_BASE,
        STORAGE_KEYS,

        getCurrentPage,
        redirectTo,

        getCurrentUser,
        getCurrentUserId,
        isAuthenticated,

        isMonitoringSessionActive,
        markMonitoringSessionStarted,
        markMonitoringSessionStopped,
        clearSessionFlowState,
        getLastSessionSummary,

        getBackendSessionStatus,
        requireAuth,
        redirectAuthenticatedAwayFromAuthPage,
        requireNoActiveMonitoring,
        requireActiveMonitoringSession,
        requireSummaryAccess,
        requireHistoryAccess,
        enforceCurrentPageFlow,

        logout,
    };

    document.addEventListener("DOMContentLoaded", () => {
        enforceCurrentPageFlow();
    });

    installBrowserHistoryGuard();
})();