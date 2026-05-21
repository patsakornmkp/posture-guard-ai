/* =========================================
   Monitoring Page
   File: frontend/js/monitoring.js

   เวอร์ชันใหม่ (realtime mode):
   - ใช้ CVA สำหรับคอยื่น
   - ใช้ FSA สำหรับไหล่ห่อ
   - ไม่มี warning / เฝ้าระวัง
   - ไม่มีหลังคร่อม / hunched back
   - แจ้งเตือนเมื่อ backend ส่ง alert = true
   - แจ้งเตือนเพิ่มเมื่อ alert_active เปลี่ยนจาก false เป็น true
   - แสดงจำนวนแจ้งเตือนแยกคอยื่น / ไหล่ห่อ / รวม
   - ไม่มี planned duration / auto-stop — ผู้ใช้กดหยุดเอง
   - หยุดนับเวลาใช้งานเมื่อไม่พบผู้ใช้งานในกล้อง
========================================= */

(function () {
    "use strict";

    let videoInterval = null;
    let pollInterval = null;
    let elapsedInterval = null;

    let notificationEnabled = false;
    let sessionEnded = false;

    let notificationPermissionAsked = false;
    let lastFrontendAlertTime = 0;
    let videoFrameLoading = false;

    // จำสถานะ alert active รอบก่อนหน้า
    // ใช้กันกรณี frontend polling พลาดจังหวะ alert=true จาก backend
    let lastForwardHeadAlertActive = false;
    let lastRoundedShoulderAlertActive = false;

    // เวลาที่แสดงบนหน้า monitoring
    // ใช้ backend เป็นแหล่งอ้างอิงหลัก และให้ frontend ช่วยเดินเวลาให้ดู smooth
    let displayedElapsedSeconds = 0;
    let elapsedCountingActive = false;
    let lastElapsedTick = null;

    const VIDEO_FRAME_INTERVAL = 700;
    const POSTURE_POLL_INTERVAL = 1500;
    const TIMER_INTERVAL = 1000;

    // กันแจ้งเตือนซ้ำจาก frontend กรณี polling เด้งรอบเดียวกัน
    // backend เป็นตัวคุมการเตือนซ้ำหลัก
    const FRONTEND_ALERT_COOLDOWN = 5000;

    const $ = (id) => document.getElementById(id);

    document.addEventListener("DOMContentLoaded", () => {
        const user = utils.requireAuth();
        if (!user) return;

        displayedElapsedSeconds = 0;
        elapsedCountingActive = false;
        lastElapsedTick = Date.now();

        lastForwardHeadAlertActive = false;
        lastRoundedShoulderAlertActive = false;

        // realtime mode: ไม่จำกัดเวลา
        // plannedTime / remainingTime อาจไม่มีใน HTML แล้ว
        // setText มี guard จึงไม่ทำให้หน้า error
        setText("plannedTime", "ไม่จำกัด");
        setText("remainingTime", "Realtime");
        setText("elapsedTime", formatTime(displayedElapsedSeconds));

        setupVideoStatus();
        setupNotificationToggle();

        const stopBtn = $("stopBtn");
        if (stopBtn) {
            stopBtn.addEventListener("click", () => stopSession());
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

            updateElapsedCountingState(posture || {});
            renderPosture(posture || {});
            renderStats(summary || {});
            handleAlertEvent(posture || {});
        } catch (err) {
            console.error("polling error:", err);
            pauseElapsedTimer();
            renderConnectionError();
        }
    }

    /* =========================
       Elapsed Time Control
    ========================= */

    function updateElapsedCountingState(posture) {
        const shouldCount = shouldCountElapsedTime(posture);

        if (elapsedCountingActive === shouldCount) {
            return;
        }

        elapsedCountingActive = shouldCount;
        lastElapsedTick = Date.now();
    }

    function shouldCountElapsedTime(posture) {
        const status = posture.status || "no_person_detected";

        // นับเวลาเฉพาะตอนระบบตรวจเจอผู้ใช้งานจริง
        // good = อยู่ในกล้องและท่าปกติ
        // bad = อยู่ในกล้องแต่ท่าผิด
        return status === "good" || status === "bad";
    }

    function pauseElapsedTimer() {
        elapsedCountingActive = false;
        lastElapsedTick = Date.now();
    }

    function syncElapsedTimeFromSummary(summary) {
        const backendEffectiveSeconds = Number(summary.effective_seated_seconds);

        if (!Number.isFinite(backendEffectiveSeconds) || backendEffectiveSeconds < 0) {
            return;
        }

        /*
           ใช้ backend เป็นแหล่งอ้างอิงหลัก แต่ไม่ยอมให้เวลาบนหน้าเด้งถอยหลัง

           เหตุผล:
           - frontend เดินเวลาเองทุก 1 วินาทีเพื่อให้ UI ดูลื่น
           - backend ส่งค่า effective_seated_seconds กลับมาเป็นรอบ ๆ
           - ถ้า sync แบบทับค่าทุกครั้ง เวลาอาจเด้ง/กระตุก
        */
        if (backendEffectiveSeconds > displayedElapsedSeconds) {
            displayedElapsedSeconds = backendEffectiveSeconds;
        }

        lastElapsedTick = Date.now();
        setText("elapsedTime", formatTime(displayedElapsedSeconds));
    }

    function updateElapsedTime() {
        if (sessionEnded) return;

        const now = Date.now();

        if (!lastElapsedTick) {
            lastElapsedTick = now;
        }

        if (!elapsedCountingActive) {
            lastElapsedTick = now;
            setText("elapsedTime", formatTime(displayedElapsedSeconds));
            return;
        }

        const delta = (now - lastElapsedTick) / 1000;
        lastElapsedTick = now;

        /*
           ป้องกันเวลาเดินแปลกเมื่อ browser หน่วง / tab ถูกพัก / เครื่องกระตุก

           ถ้า delta ใหญ่ผิดปกติ ไม่บวกเวลาพรวดเดียว
           เพราะเวลาที่ถูกต้องจะถูก sync จาก backend ในรอบ polling ถัดไป
        */
        if (delta > 0 && delta <= 5) {
            displayedElapsedSeconds += delta;
        }

        setText("elapsedTime", formatTime(displayedElapsedSeconds));
    }

    /* =========================
       Alert Event
    ========================= */

    function handleAlertEvent(posture) {
        const now = Date.now();

        const forwardHeadAlert = posture.forward_head_alert === true;
        const roundedShoulderAlert = posture.rounded_shoulder_alert === true;

        const forwardHeadAlertActive = posture.forward_head_alert_active === true;
        const roundedShoulderAlertActive = posture.rounded_shoulder_alert_active === true;

        const directAlert = (
            posture.alert === true
            || forwardHeadAlert
            || roundedShoulderAlert
        );

        const becameForwardHeadActive = (
            forwardHeadAlertActive
            && !lastForwardHeadAlertActive
        );

        const becameRoundedShoulderActive = (
            roundedShoulderAlertActive
            && !lastRoundedShoulderAlertActive
        );

        // อัปเดต snapshot ทุกครั้ง เพื่อให้รู้ว่ารอบหน้าเป็นการเปลี่ยนสถานะจริงไหม
        lastForwardHeadAlertActive = forwardHeadAlertActive;
        lastRoundedShoulderAlertActive = roundedShoulderAlertActive;

        /*
           แจ้งเตือนเมื่อ:
           1) backend ส่ง alert=true โดยตรง
           2) backend ส่ง forward_head_alert / rounded_shoulder_alert
           3) frontend พลาด alert=true แต่เห็น alert_active เปลี่ยนจาก false เป็น true
        */
        const shouldNotify = (
            directAlert
            || becameForwardHeadActive
            || becameRoundedShoulderActive
        );

        if (!shouldNotify) return;

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

        syncElapsedTimeFromSummary(s);

        setText("goodTime", formatTime(s.good_posture_seconds || 0));
        setText("forwardHeadAlertCount", `${forwardHeadAlertCount} ครั้ง`);
        setText("roundedShoulderAlertCount", `${roundedShoulderAlertCount} ครั้ง`);
        setText("alertCount", `${totalAlertCount} ครั้ง`);
    }

    /* =========================
       Message Builders
    ========================= */

    function buildPostureAlertMessage(posture) {
        const issues = [];

        if (
            posture.forward_head_alert === true
            || posture.forward_head_alert_active === true
        ) {
            issues.push("คอยื่นต่อเนื่องเกินเวลาที่กำหนด");
        }

        if (
            posture.rounded_shoulder_alert === true
            || posture.rounded_shoulder_alert_active === true
        ) {
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

    async function stopSession() {
        if (sessionEnded) return;

        sessionEnded = true;
        pauseElapsedTimer();

        const stopBtn = $("stopBtn");

        if (stopBtn) {
            stopBtn.disabled = true;
            stopBtn.textContent = "กำลังหยุด...";
        }

        try {
            stopPolling();

            if (window.alertSpeech) {
                window.alertSpeech.disable();
            }

            const sessionId = localStorage.getItem("currentSessionId");

            // สำคัญ:
            // stop session ต้องสำเร็จก่อน จึงค่อยไปหน้า summary
            // เพื่อให้ backend บันทึก end_time / summary / history ถูกต้อง
            await api.stopSession();

            // stop camera ถ้าพลาด ไม่ควรทำให้ข้อมูล session หาย
            try {
                await api.stopCamera();
            } catch (_) {}

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