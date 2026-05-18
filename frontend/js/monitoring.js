/* =========================================
   Monitoring Page
   File: frontend/js/monitoring.js

   เวอร์ชันใหม่:
   - ใช้ CVA สำหรับคอยื่น
   - ใช้ FSA สำหรับไหล่ห่อ
   - ไม่มี warning / เฝ้าระวัง
   - ไม่มีหลังคร่อม / hunched back
   - แจ้งเตือนเฉพาะเมื่อ backend ส่ง alert = true
   - แสดงจำนวนแจ้งเตือนแยกคอยื่น / ไหล่ห่อ / รวม
========================================= */

(function () {
    "use strict";

    let videoInterval = null;
    let pollInterval = null;
    let elapsedInterval = null;

    let startTime = Date.now();
    let notificationEnabled = false;
    let plannedSeconds = 0;
    let sessionEnded = false;

    let notificationPermissionAsked = false;
    let lastFrontendAlertTime = 0;
    let videoFrameLoading = false;

    const VIDEO_FRAME_INTERVAL = 700;
    const POSTURE_POLL_INTERVAL = 1500;
    const TIMER_INTERVAL = 1000;

    // กันแจ้งเตือนซ้ำจาก frontend กรณี polling เด้งรอบเดียวกัน
    // backend เป็นตัวคุมการเตือนซ้ำทุก 3 นาที
    const FRONTEND_ALERT_COOLDOWN = 5000;

    const $ = (id) => document.getElementById(id);

    document.addEventListener("DOMContentLoaded", () => {
        const user = utils.requireAuth();
        if (!user) return;

        const plannedMinutes = parseInt(
            localStorage.getItem("plannedMinutes") || "30",
            10
        );

        plannedSeconds = plannedMinutes * 60;
        startTime = Date.now();

        setText("plannedTime", formatTime(plannedSeconds));
        setText("remainingTime", formatTime(plannedSeconds));

        setupVideoStatus();
        setupNotificationToggle();

        const stopBtn = $("stopBtn");
        if (stopBtn) {
            stopBtn.addEventListener("click", () => stopSession(false));
        }

        startPolling();
    });

    /* =========================
       Camera / Video
    ========================= */

    function setupVideoStatus() {
        const video = $("videoFeed");
        const cameraStatus = $("cameraStatus");

        if (!video || !cameraStatus) return;

        video.addEventListener("load", () => {
            cameraStatus.textContent = "กล้องทำงานอยู่";
            cameraStatus.classList.add("is-ready");
            cameraStatus.classList.remove("is-error");
        });

        video.addEventListener("error", () => {
            cameraStatus.textContent = "ไม่สามารถโหลดภาพจากกล้อง";
            cameraStatus.classList.add("is-error");
            cameraStatus.classList.remove("is-ready");
        });
    }

    function updateVideoFrame() {
        const video = $("videoFeed");
        if (!video) return;

        if (videoFrameLoading) return;

        videoFrameLoading = true;

        const done = () => {
            videoFrameLoading = false;
            video.removeEventListener("load", done);
            video.removeEventListener("error", done);
        };

        video.addEventListener("load", done);
        video.addEventListener("error", done);

        video.src = api.videoFrameUrl();
    }

    /* =========================
       Notification
    ========================= */

    function setupNotificationToggle() {
        const toggle = $("notifyToggleBtn");
        const desc = $("notifyDesc");

        if (!toggle) return;

        if (!("Notification" in window)) {
            notificationEnabled = false;
            toggle.checked = false;
            toggle.disabled = true;
            if (desc) desc.textContent = "ไม่รองรับ";
            return;
        }

        if (!window.isSecureContext) {
            notificationEnabled = false;
            toggle.checked = false;
            toggle.disabled = true;
            if (desc) desc.textContent = "ต้องใช้ localhost/HTTPS";
            return;
        }

        if (Notification.permission === "granted") {
            notificationEnabled = true;
            toggle.checked = true;
            if (desc) desc.textContent = "เปิดอยู่";
        } else if (Notification.permission === "denied") {
            notificationEnabled = false;
            toggle.checked = false;
            if (desc) desc.textContent = "ถูกบล็อก";
        } else {
            notificationEnabled = false;
            toggle.checked = false;
            if (desc) desc.textContent = "กดเพื่อเปิด";
        }

        toggle.addEventListener("change", async () => {
            if (toggle.checked) {
                const granted = await requestNotificationPermission();

                notificationEnabled = granted;
                toggle.checked = granted;

                if (desc) {
                    desc.textContent = granted ? "เปิดอยู่" : "ยังไม่อนุญาต";
                }
            } else {
                notificationEnabled = false;

                if (desc) {
                    desc.textContent = "ปิดอยู่";
                }
            }
        });
    }

    async function requestNotificationPermission() {
        if (!("Notification" in window)) {
            setText("notifyDesc", "ไม่รองรับ");
            return false;
        }

        if (!window.isSecureContext) {
            setText("notifyDesc", "ต้องใช้ localhost/HTTPS");
            return false;
        }

        if (Notification.permission === "granted") {
            setText("notifyDesc", "เปิดอยู่");
            return true;
        }

        if (Notification.permission === "denied") {
            setText("notifyDesc", "ถูกบล็อก");
            return false;
        }

        if (Notification.permission === "default" && !notificationPermissionAsked) {
            notificationPermissionAsked = true;

            const permission = await Notification.requestPermission();

            if (permission === "granted") {
                setText("notifyDesc", "เปิดอยู่");
                return true;
            }

            if (permission === "denied") {
                setText("notifyDesc", "ถูกบล็อก");
                return false;
            }

            setText("notifyDesc", "ยังไม่อนุญาต");
            return false;
        }

        return Notification.permission === "granted";
    }

    function showBrowserNotification(message) {
        if (!notificationEnabled) return;

        if (!("Notification" in window)) {
            setText("notifyDesc", "ไม่รองรับ");
            return;
        }

        if (Notification.permission !== "granted") {
            setText("notifyDesc", "ยังไม่อนุญาต");
            return;
        }

        new Notification("PostureGuard AI", {
            body: message || "กรุณาปรับท่านั่งให้อยู่ในท่าที่เหมาะสม",
            silent: false,
        });
    }

    /* =========================
       Polling
    ========================= */

    function startPolling() {
        if (videoInterval || pollInterval || elapsedInterval) return;

        updateVideoFrame();
        updatePosture();
        updateElapsedTime();

        videoInterval = setInterval(updateVideoFrame, VIDEO_FRAME_INTERVAL);
        pollInterval = setInterval(updatePosture, POSTURE_POLL_INTERVAL);
        elapsedInterval = setInterval(updateElapsedTime, TIMER_INTERVAL);
    }

    function stopPolling() {
        clearInterval(videoInterval);
        clearInterval(pollInterval);
        clearInterval(elapsedInterval);

        videoInterval = null;
        pollInterval = null;
        elapsedInterval = null;
    }

    async function updatePosture() {
        if (sessionEnded) return;

        try {
            const posture = await api.getCurrentPosture();
            const summary = await api.getSessionSummary();

            renderPosture(posture || {});
            renderStats(summary || {});
            handleAlertEvent(posture || {});
        } catch (err) {
            console.error("polling error:", err);
            renderConnectionError();
        }
    }

    /* =========================
       Alert Event
    ========================= */

    function handleAlertEvent(posture) {
        const now = Date.now();

        // แจ้งเตือนเฉพาะตอน backend ส่ง alert = true เท่านั้น
        if (posture.alert !== true) return;

        if (now - lastFrontendAlertTime < FRONTEND_ALERT_COOLDOWN) {
            return;
        }

        lastFrontendAlertTime = now;

        const alertMessage = buildPostureAlertMessage(posture);

        showBrowserNotification(alertMessage);

        if (window.alertSpeech) {
            window.alertSpeech.speak(alertMessage);
        }
    }

    /* =========================
       Render UI
    ========================= */

    function renderConnectionError() {
        const cameraStatus = $("cameraStatus");

        if (cameraStatus) {
            cameraStatus.textContent = "เชื่อมต่อ backend ไม่ได้";
            cameraStatus.classList.add("is-error");
            cameraStatus.classList.remove("is-ready");
        }

        const statusCard = $("statusCard");
        if (statusCard) {
            statusCard.className = "status-card status-idle";
        }

        setText("statusBadge", "รอการเชื่อมต่อ");
        setText("statusMessage", "Backend connection failed");
        setText(
            "currentAdvice",
            "ตรวจสอบว่า backend เปิดอยู่ แล้ว refresh หน้าอีกครั้ง"
        );
    }

    function renderPosture(p) {
        const statusMap = {
            good: {
                label: "ปกติ",
                klass: "",
                englishMessage: "Normal posture",
                advice: "ท่าทางอยู่ในเกณฑ์ปกติ",
            },
            bad: {
                label: "อันตราย",
                klass: "status-bad",
                englishMessage: "Improper posture detected",
                advice: "ค่ามุมไม่อยู่ในเกณฑ์ปกติ",
            },
            paused: {
                label: "หยุดชั่วคราว",
                klass: "status-idle",
                englishMessage: "Session paused",
                advice: "จัดตำแหน่งให้อยู่ในกรอบกล้อง",
            },
            no_person_detected: {
                label: "ไม่พบผู้ใช้งาน",
                klass: "status-idle",
                englishMessage: "No person detected",
                advice: "กรุณานั่งให้อยู่ในกรอบกล้อง",
            },
            marker_not_detected: {
                label: "ไม่พบ Marker",
                klass: "status-idle",
                englishMessage: "Marker not detected",
                advice: "ตรวจสอบตำแหน่งสติกเกอร์และแสงสว่าง",
            },
        };

        const status = p.status || "no_person_detected";
        const item = statusMap[status] || statusMap.no_person_detected;

        const statusCard = $("statusCard");
        if (statusCard) {
            statusCard.className = `status-card ${item.klass}`;
        }

        setText("statusBadge", item.label);
        setText("statusMessage", item.englishMessage);
        setText("currentAdvice", buildCurrentAdvice(p, item.advice));

        setText("cvaValue", formatMetric(p.cva_angle));
        setText("fsaValue", formatMetric(p.fsa_angle));

        setText("cvaHint", getCvaHint(p.cva_angle, p));
        setText("fsaHint", getRoundedShoulderHint(p.fsa_angle, p));
    }

    function renderStats(s) {
        const totalAlertCount = Number(s.alert_count || 0);
        const forwardHeadAlertCount = Number(s.forward_head_alert_count || 0);
        const roundedShoulderAlertCount = Number(s.rounded_shoulder_alert_count || 0);

        setText("goodTime", formatTime(s.good_posture_seconds || 0));
        setText("forwardHeadAlertCount", `${forwardHeadAlertCount} ครั้ง`);
        setText("roundedShoulderAlertCount", `${roundedShoulderAlertCount} ครั้ง`);
        setText("alertCount", `${totalAlertCount} ครั้ง`);
    }

    function updateElapsedTime() {
        if (sessionEnded) return;

        const elapsed = Math.floor((Date.now() - startTime) / 1000);
        const remaining = Math.max(plannedSeconds - elapsed, 0);
        const progress = plannedSeconds > 0
            ? Math.min((elapsed / plannedSeconds) * 100, 100)
            : 0;

        setText("elapsedTime", formatTime(elapsed));
        setText("remainingTime", formatTime(remaining));

        const bar = $("sessionProgressBar");
        if (bar) {
            bar.style.width = `${progress}%`;
        }

        if (plannedSeconds > 0 && elapsed >= plannedSeconds) {
            stopSession(true);
        }
    }

    /* =========================
       Message Builders
    ========================= */

    function buildPostureAlertMessage(posture) {
        const issues = [];

        if (posture.forward_head_alert === true) {
            issues.push("คอยื่นต่อเนื่องเกินเวลาที่กำหนด");
        }

        if (posture.rounded_shoulder_alert === true) {
            issues.push("ไหล่ห่อต่อเนื่องเกินเวลาที่กำหนด");
        }

        if (issues.length === 0) {
            return posture.message || "กรุณาปรับท่านั่ง";
        }

        return `${issues.join(" | ")} · กรุณาปรับท่านั่ง`;
    }

    function buildCurrentAdvice(posture, fallback) {
        const issues = [];

        if (posture.is_forward_head === true) {
            const duration = Number(posture.forward_head_duration || 0);
            const isActive = posture.forward_head_alert_active === true;

            issues.push(
                isActive
                    ? "คอยื่น: แจ้งเตือนแล้ว"
                    : `คอยื่น ${formatTime(duration)}`
            );
        }

        if (posture.is_rounded_shoulder === true) {
            const duration = Number(posture.rounded_shoulder_duration || 0);
            const isActive = posture.rounded_shoulder_alert_active === true;

            issues.push(
                isActive
                    ? "ไหล่ห่อ: แจ้งเตือนแล้ว"
                    : `ไหล่ห่อ ${formatTime(duration)}`
            );
        }

        if (issues.length > 0) {
            return `${issues.join(" | ")} · กรุณาปรับท่านั่ง`;
        }

        if (posture.status === "good") {
            return "ท่าทางอยู่ในเกณฑ์ปกติ";
        }

        return fallback || "ระบบกำลังวิเคราะห์ท่าทาง";
    }

    /* =========================
       Hints
    ========================= */

    function getCvaHint(value, posture = {}) {
        if (value == null || Number.isNaN(Number(value))) {
            return "อ่านค่าไม่ได้";
        }

        const n = Number(value);

        if (n >= 50) {
            return "ปกติ";
        }

        if (posture.forward_head_alert_active === true) {
            return "แจ้งเตือนแล้ว";
        }

        return `จับเวลา ${formatTime(posture.forward_head_duration || 0)}`;
    }

    function getRoundedShoulderHint(value, posture = {}) {
        if (value == null || Number.isNaN(Number(value))) {
            return "อ่านค่าไม่ได้";
        }

        const n = Number(value);

        if (n >= 54) {
            return "ปกติ";
        }

        if (posture.rounded_shoulder_alert_active === true) {
            return "แจ้งเตือนแล้ว";
        }

        return `จับเวลา ${formatTime(posture.rounded_shoulder_duration || 0)}`;
    }

    /* =========================
       Stop Session
    ========================= */

    async function stopSession(isAutoStop = false) {
        if (sessionEnded) return;

        sessionEnded = true;

        const stopBtn = $("stopBtn");

        if (stopBtn) {
            stopBtn.disabled = true;
            stopBtn.textContent = isAutoStop
                ? "ครบเวลา กำลังสรุปผล..."
                : "กำลังหยุด...";
        }

        try {
            stopPolling();

            if (window.alertSpeech) {
                window.alertSpeech.disable();
            }

            const sessionId = localStorage.getItem("currentSessionId");

            try {
                await api.stopSession();
            } catch (_) { }

            try {
                await api.stopCamera();
            } catch (_) { }

            localStorage.setItem("lastSessionId", sessionId || "");
            window.location.href = "summary.html";
        } catch (err) {
            alert("หยุด session ไม่สำเร็จ: " + err.message);

            if (stopBtn) {
                stopBtn.disabled = false;
                stopBtn.textContent = "⏹ หยุดการใช้งาน";
            }

            sessionEnded = false;
            startPolling();
        }
    }

    /* =========================
       Utilities
    ========================= */

    function formatMetric(value) {
        if (value == null || Number.isNaN(Number(value))) {
            return "—";
        }

        return Number(value).toFixed(1);
    }

    function formatTime(totalSeconds) {
        const s = Math.floor(totalSeconds || 0);
        const h = Math.floor(s / 3600);
        const m = Math.floor((s % 3600) / 60);
        const sec = s % 60;

        if (h > 0) {
            return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
        }

        return `${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
    }

    function setText(id, value) {
        const el = $(id);
        if (!el) return;

        const text = String(value);

        if (el.textContent !== text) {
            el.textContent = text;
        }
    }
})();