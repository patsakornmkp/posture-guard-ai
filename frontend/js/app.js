/* =========================================
   PostureGuard — Frontend Application
   Shared across all pages (login, register, setup, monitoring, summary, history)

   หมายเหตุ:
   - ไฟล์นี้เป็นตัวกลางสำหรับเรียก API backend
   - ไม่ได้คำนวณ CVA/FSA
   - ไม่ได้ควบคุมเวลานั่งผิดก่อนแจ้งเตือน
   - เวลาแจ้งเตือนอยู่ที่ backend/config.py
   - realtime mode ใช้ planned_duration_minutes = 0
========================================= */

// ห่อทั้งหมดด้วย IIFE + guard เพื่อไม่ให้ define ซ้ำ
// ถ้าไฟล์นี้โหลดซ้ำก็ไม่ error
(function () {
    if (window.__postureGuardLoaded) return;
    window.__postureGuardLoaded = true;

    // ---------- CONFIG ----------
    // แก้ตัวนี้ถ้า backend รันที่ host อื่น
    // ถ้าเปิด frontend จากเครื่องเดียวกับ backend ให้ใช้ localhost ได้
    // ถ้าเปิด frontend จาก notebook แต่ backend อยู่ Raspberry Pi ให้เปลี่ยนเป็น IP ของ Raspberry Pi
    const API_BASE = 'http://localhost:8000';
    const STORAGE_KEYS = {
        currentUser: 'currentUser',
        currentSessionId: 'currentSessionId',
        plannedMinutes: 'plannedMinutes',
        lastSessionId: 'lastSessionId',
        lastSessionSummary: 'lastSessionSummary',
        monitoringSessionActive: 'monitoringSessionActive',
    };

    // ---------- API CLIENT ----------
    async function apiRequest(method, path, body = null) {
        const options = {
            method,
            headers: {
                'Content-Type': 'application/json',
            },
        };

        if (body !== null) {
            options.body = JSON.stringify(body);
        }

        let response;

        try {
            response = await fetch(API_BASE + path, options);
        } catch (err) {
            throw new Error(
                'ไม่สามารถเชื่อมต่อ backend ได้ — โปรดตรวจสอบว่า server เปิดอยู่'
            );
        }

        let data = null;
        const contentType = response.headers.get('content-type') || '';

        if (contentType.includes('application/json')) {
            data = await response.json();
        }

        if (!response.ok) {
            const message = data?.detail || `Error ${response.status}`;
            throw new Error(message);
        }

        return data;
    }

    // ---------- Public API ----------
    window.api = {
        // Auth
        register(username, password, fullName = '') {
            return apiRequest('POST', '/auth/register', {
                username,
                password,
                full_name: fullName,
            });
        },

        login(username, password) {
            return apiRequest('POST', '/auth/login', {
                username,
                password,
            }).then((res) => res.user);
        },

        // Health
        health() {
            return apiRequest('GET', '/');
        },

        // Camera
        startCamera() {
            return apiRequest('POST', '/camera/start');
        },

        stopCamera() {
            return apiRequest('POST', '/camera/stop');
        },

        // Posture
        getCurrentPosture() {
            return apiRequest('GET', '/posture/current');
        },

        // Calibration
        calibrate() {
            return apiRequest('POST', '/calibrate');
        },

        // Session
        // plannedMinutes = 0 หมายถึง realtime mode / ไม่จำกัดเวลา
        // ไม่ใช่เวลานั่งผิดก่อนแจ้งเตือน
        startSession(userId, plannedMinutes = 0) {
            return apiRequest('POST', '/session/start', {
                user_id: userId,
                planned_duration_minutes: plannedMinutes,
            });
        },

        stopSession() {
            return apiRequest('POST', '/session/stop');
        },

        getSessionSummary() {
            return apiRequest('GET', '/session/summary');
        },

        // History
        getHistory(userId, limit = 50) {
            return apiRequest(
                'GET',
                `/history/sessions/${userId}?limit=${limit}`
            );
        },

        getSessionLogs(sessionId) {
            return apiRequest(
                'GET',
                `/history/session/${sessionId}/logs`
            );
        },

        // Video frame URL ใช้ใน <img src>
        videoFrameUrl() {
            return `${API_BASE}/video/frame?t=${Date.now()}`;
        },
    };

    // ---------- Navigation / Session Flow Helpers ----------
    function getCurrentPage() {
        return window.location.pathname.split('/').pop() || 'login.html';
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
        const userRaw = localStorage.getItem(STORAGE_KEYS.currentUser);

        if (!userRaw) return null;

        try {
            return JSON.parse(userRaw);
        } catch (err) {
            localStorage.removeItem(STORAGE_KEYS.currentUser);
            return null;
        }
    }

    function isAuthenticated() {
        return Boolean(getCurrentUser());
    }

    function isMonitoringSessionActive() {
        return (
            localStorage.getItem(STORAGE_KEYS.monitoringSessionActive) === 'true'
            || Boolean(localStorage.getItem(STORAGE_KEYS.currentSessionId))
        );
    }

    function markMonitoringSessionStarted(sessionId) {
        if (sessionId !== undefined && sessionId !== null) {
            localStorage.setItem(STORAGE_KEYS.currentSessionId, String(sessionId));
        }

        localStorage.setItem(STORAGE_KEYS.monitoringSessionActive, 'true');
        localStorage.setItem(STORAGE_KEYS.plannedMinutes, '0');
        localStorage.removeItem(STORAGE_KEYS.lastSessionSummary);
    }

    function markMonitoringSessionStopped(summary = null) {
        const sessionId = localStorage.getItem(STORAGE_KEYS.currentSessionId);

        if (sessionId) {
            localStorage.setItem(STORAGE_KEYS.lastSessionId, sessionId);
        }

        if (summary) {
            try {
                localStorage.setItem(
                    STORAGE_KEYS.lastSessionSummary,
                    JSON.stringify(summary)
                );
            } catch (err) {
                console.warn('Cannot cache last session summary:', err);
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
        } catch (err) {
            localStorage.removeItem(STORAGE_KEYS.lastSessionSummary);
            return null;
        }
    }

    async function getBackendSessionSummarySafe() {
        try {
            return await apiRequest('GET', '/session/summary');
        } catch (err) {
            console.warn('Cannot validate backend session:', err.message);
            return null;
        }
    }

    async function isBackendSessionActive() {
        const summary = await getBackendSessionSummarySafe();
        return summary?.session_active === true;
    }

    function requireAuth() {
        const user = getCurrentUser();

        if (!user) {
            redirectTo('login.html', { replace: true });
            return null;
        }

        return user;
    }

    async function redirectAuthenticatedAwayFromAuthPage() {
        if (!isAuthenticated()) {
            return true;
        }

        if (isMonitoringSessionActive()) {
            const active = await isBackendSessionActive();

            if (active) {
                redirectTo('monitoring.html', { replace: true });
                return false;
            }

            clearSessionFlowState({ keepLast: true });
        }

        redirectTo('setup.html', { replace: true });
        return false;
    }

    async function requireNoActiveMonitoring() {
        const user = requireAuth();
        if (!user) return false;

        if (!isMonitoringSessionActive()) {
            return true;
        }

        const active = await isBackendSessionActive();

        if (active) {
            redirectTo('monitoring.html', { replace: true });
            return false;
        }

        clearSessionFlowState({ keepLast: true });
        return true;
    }

    async function requireActiveMonitoringSession() {
        const user = requireAuth();
        if (!user) return false;

        const summary = await getBackendSessionSummarySafe();

        if (summary?.session_active === true) {
            if (!isMonitoringSessionActive()) {
                localStorage.setItem(STORAGE_KEYS.monitoringSessionActive, 'true');
            }

            return true;
        }

        clearSessionFlowState({ keepLast: true });

        if (getLastSessionSummary() || localStorage.getItem(STORAGE_KEYS.lastSessionId)) {
            redirectTo('summary.html', { replace: true });
        } else {
            redirectTo('setup.html', { replace: true });
        }

        return false;
    }

    async function requireSummaryAccess() {
        const user = requireAuth();
        if (!user) return false;

        if (!isMonitoringSessionActive()) {
            return true;
        }

        const active = await isBackendSessionActive();

        if (active) {
            redirectTo('monitoring.html', { replace: true });
            return false;
        }

        clearSessionFlowState({ keepLast: true });
        return true;
    }

    async function enforceCurrentPageFlow() {
        const page = getCurrentPage();

        if (page === 'login.html' || page === 'register.html') {
            await redirectAuthenticatedAwayFromAuthPage();
            return;
        }

        if (page === 'setup.html') {
            await requireNoActiveMonitoring();
            return;
        }

        if (page === 'monitoring.html') {
            await requireActiveMonitoringSession();
            return;
        }

        if (page === 'summary.html') {
            await requireSummaryAccess();
        }
    }

    function installBrowserHistoryGuard() {
        window.addEventListener('pageshow', (event) => {
            // browser back/forward cache อาจคืนหน้าเก่ากลับมาโดยไม่ reload ใหม่
            if (event.persisted) {
                enforceCurrentPageFlow();
            }
        });

        window.addEventListener('popstate', () => {
            enforceCurrentPageFlow();
        });
    }

    // ---------- Helpers ----------
    window.utils = {
        STORAGE_KEYS,
        getCurrentPage,
        redirectTo,
        getCurrentUser,
        isAuthenticated,
        isMonitoringSessionActive,
        markMonitoringSessionStarted,
        markMonitoringSessionStopped,
        clearSessionFlowState,
        getLastSessionSummary,
        requireAuth,
        requireNoActiveMonitoring,
        requireActiveMonitoringSession,
        requireSummaryAccess,
        redirectAuthenticatedAwayFromAuthPage,
        enforceCurrentPageFlow,

        // logout → ล้าง localStorage + ไปหน้า login
        logout() {
            localStorage.removeItem(STORAGE_KEYS.currentUser);
            clearSessionFlowState({ keepLast: false });
            redirectTo('login.html', { replace: true });
        },
    };

    document.addEventListener('DOMContentLoaded', () => {
        enforceCurrentPageFlow();
    });

    installBrowserHistoryGuard();
})();