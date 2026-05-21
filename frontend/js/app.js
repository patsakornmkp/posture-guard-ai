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

    // ---------- Helpers ----------
    window.utils = {
        // เช็คว่า login อยู่ไหม ถ้าไม่ login ให้ redirect ไปหน้า login
        requireAuth() {
            const userRaw = localStorage.getItem('currentUser');

            if (!userRaw) {
                window.location.href = 'login.html';
                return null;
            }

            try {
                return JSON.parse(userRaw);
            } catch (err) {
                localStorage.removeItem('currentUser');
                window.location.href = 'login.html';
                return null;
            }
        },

        // logout → ล้าง localStorage + ไปหน้า login
        logout() {
            localStorage.removeItem('currentUser');
            localStorage.removeItem('currentSessionId');
            localStorage.removeItem('plannedMinutes');
            localStorage.removeItem('lastSessionId');

            window.location.href = 'login.html';
        },
    };
})();