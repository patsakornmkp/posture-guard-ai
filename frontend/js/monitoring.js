/* =========================================
   Monitoring Page
   File: frontend/js/monitoring.js

   ใช้กับหน้า realtime monitoring ของ PostureGuard AI
   - ใช้ CVA สำหรับคอยื่น
   - ใช้ FSA สำหรับไหล่ห่อ
   - ไม่มี Calibration / Baseline
   - ไม่มี hunched back / kyphosis
   - แจ้งเตือนเมื่อ backend ส่ง alert จริง
   - ปรับ UX แบบ minimal-change:
     1) กันเข้าหน้า monitoring โดยไม่มี active session
     2) กัน browser back ระหว่าง monitoring
     3) กันกดปุ่มหยุดซ้ำ
     4) ถ้า backend หลุด ไม่ล้าง session ทันที
     5) ถ้า session ไม่ active แล้ว redirect ไป summary อย่างถูกต้อง
========================================= */

(function () {
    "use strict";

    let videoInterval = null;
    let pollInterval = null;
    let elapsedInterval = null;

    let sessionEnded = false;
    let videoFrameLoading = false;
    let isStopping = false;

    let notificationEnabled = false;
    let notificationPermissionAsked = false;
    let lastFrontendAlertTime = 0;

    let lastForwardHeadAlertActive = false;
    let lastRoundedShoulderAlertActive = false;

    let displayedElapsedSeconds = 0;
    let elapsedCountingActive = false;
    let lastElapsedTick = null;

    let connectionErrorCount = 0;

    const VIDEO_FRAME_INTERVAL = 700;
    const POSTURE_POLL_INTERVAL = 1500;
    const ELAPSED_INTERVAL = 1000;
    const FRONTEND_ALERT_COOLDOWN = 5000;
    const ALERT_DURATION_SECONDS = 180;
    const CONNECTION_ERROR_VISIBLE_LIMIT = 1;

    const CVA_NORMAL_THRESHOLD = 50;
    const FSA_NORMAL_THRESHOLD = 54;

    const $ = (id) => document.getElementById(id);

    document.addEventListener("DOMContentLoaded", async () => {
        if (!window.api || !window.utils) {
            alert("ระบบ frontend โหลดไม่ครบ กรุณาตรวจสอบการเรียกไฟล์ app.js");
            window.location.replace("login.html");
            return;
        }

        const canMonitor = await utils.requireActiveMonitoringSession();

        if (!canMonitor) {
            return;
        }

        resetLocalState();
        renderInitialLoadingState();
        lockBrowserBackDuringActiveSession();
        setupVideoStatus();
        setupNotificationToggle();
        setupStopButton();
        startPolling();
    });

    function resetLocalState() {
        sessionEnded = false;
        videoFrameLoading = false;
        isStopping = false;

        lastFrontendAlertTime = 0;
        lastForwardHeadAlertActive = false;
        lastRoundedShoulderAlertActive = false;

        displayedElapsedSeconds = 0;
        elapsedCountingActive = false;
        lastElapsedTick = Date.now();

        connectionErrorCount = 0;

        setText("elapsedTime", formatTime(0));
        setText("goodTime", formatTime(0));
        setText("forwardHeadAlertCount", "0 ครั้ง");
        setText("roundedShoulderAlertCount", "0 ครั้ง");
        setText("alertCount", "0 ครั้ง");
    }

    function renderInitialLoadingState() {
        const cameraStatus = $("cameraStatus");

        if (cameraStatus) {
            cameraStatus.textContent = "กำลังเชื่อมต่อกล้อง...";
            cameraStatus.classList.remove("is-active", "is-error");
        }

        const statusCard = $("statusCard");

        if (statusCard) {
            statusCard.className = "status-card is-waiting";
        }

        setText("statusBadge", "กำลังเริ่มระบบ");
        setText("statusMessage", "Loading monitoring session");
        setText("currentAdvice", "กรุณารอสักครู่ ระบบกำลังเชื่อมต่อกล้องและอ่านค่าท่าทาง");
    }

    /* =========================
       Browser History Guard
    ========================= */

    function lockBrowserBackDuringActiveSession() {
        try {
            window.history.replaceState(
                { postureGuardPage: "monitoring" },
                "",
                window.location.href
            );

            window.history.pushState(
                { postureGuardPage: "monitoring-lock" },
                "",
                window.location.href
            );
        } catch (err) {
            console.warn("Cannot update browser history:", err);
        }

        window.addEventListener("popstate", handleMonitoringBackNavigation);
        window.addEventListener("pageshow", handleMonitoringPageShow);
        window.addEventListener("beforeunload", handleBeforeUnload);
    }

    function unlockBrowserBackGuard() {
        window.removeEventListener("popstate", handleMonitoringBackNavigation);
        window.removeEventListener("pageshow", handleMonitoringPageShow);
        window.removeEventListener("beforeunload", handleBeforeUnload);
    }

    function handleMonitoringBackNavigation() {
        if (sessionEnded) {
            return;
        }

        if (!utils.isMonitoringSessionActive()) {
            utils.redirectTo("summary.html", { replace: true });
            return;
        }

        try {
            window.history.pushState(
                { postureGuardPage: "monitoring-lock" },
                "",
                window.location.href
            );
        } catch (err) {
            console.warn("Cannot lock browser back navigation:", err);
        }

        setText(
            "currentAdvice",
            "หากต้องการออกจากหน้านี้ กรุณากดปุ่มหยุดการใช้งานก่อน เพื่อให้ระบบบันทึกและสรุปผลได้ถูกต้อง"
        );
    }

    async function handleMonitoringPageShow(event) {
        if (sessionEnded) {
            return;
        }

        if (event.persisted && window.utils) {
            const canMonitor = await utils.requireActiveMonitoringSession();

            if (!canMonitor) {
                return;
            }

            if (!videoInterval && !pollInterval && !elapsedInterval) {
                startPolling();
            }
        }
    }

    function handleBeforeUnload(event) {
        if (sessionEnded || isStopping) {
            return;
        }

        if (!utils.isMonitoringSessionActive()) {
            return;
        }

        event.preventDefault();
        event.returnValue = "";
    }

    /* =========================
       Setup
    ========================= */

    function setupStopButton() {
        const stopBtn = $("stopBtn");
        if (!stopBtn) return;

        stopBtn.disabled = false;
        stopBtn.textContent = "⏹ หยุดการใช้งาน";

        stopBtn.addEventListener("click", () => {
            stopSession();
        });
    }

    function setStopButtonLoading(isLoading) {
        const stopBtn = $("stopBtn");
        if (!stopBtn) return;

        stopBtn.disabled = isLoading;
        stopBtn.textContent = isLoading ? "กำลังหยุด..." : "⏹ หยุดการใช้งาน";
    }

    function setupVideoStatus() {
        const video = $("videoFeed");
        const cameraStatus = $("cameraStatus");

        if (!video || !cameraStatus) return;

        video.addEventListener("load", () => {
            if (sessionEnded) return;

            cameraStatus.textContent = "กล้องทำงานอยู่";
            cameraStatus.classList.add("is-active");
            cameraStatus.classList.remove("is-error");
        });

        video.addEventListener("error", () => {
            if (sessionEnded) return;

            cameraStatus.textContent = "ไม่สามารถโหลดภาพจากกล้อง";
            cameraStatus.classList.add("is-error");
            cameraStatus.classList.remove("is-active");
        });
    }

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

        if (!notificationPermissionAsked) {
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
        }

        setText("notifyDesc", "ยังไม่อนุญาต");
        return false;
    }

    /* =========================
       Polling
    ========================= */

    function startPolling() {
        if (videoInterval || pollInterval || elapsedInterval) {
            return;
        }

        updateVideoFrame();
        updatePosture();
        updateElapsedTime();

        videoInterval = setInterval(updateVideoFrame, VIDEO_FRAME_INTERVAL);
        pollInterval = setInterval(updatePosture, POSTURE_POLL_INTERVAL);
        elapsedInterval = setInterval(updateElapsedTime, ELAPSED_INTERVAL);
    }

    function stopPolling() {
        clearInterval(videoInterval);
        clearInterval(pollInterval);
        clearInterval(elapsedInterval);

        videoInterval = null;
        pollInterval = null;
        elapsedInterval = null;
    }

    function updateVideoFrame() {
        const video = $("videoFeed");

        if (!video || videoFrameLoading || sessionEnded) {
            return;
        }

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

    async function updatePosture() {
        if (sessionEnded || isStopping) {
            return;
        }

        try {
            const [posture, summary] = await Promise.all([
                api.getCurrentPosture(),
                api.getSessionSummary(),
            ]);

            connectionErrorCount = 0;

            if (summary && summary.session_active === false) {
                handleInactiveBackendSession(summary);
                return;
            }

            updateElapsedCountingState(posture || {});
            renderPosture(posture || {});
            renderStats(summary || {});
            handleAlertEvent(posture || {});
        } catch (err) {
            console.error("monitoring polling error:", err);

            connectionErrorCount += 1;
            pauseElapsedTimer();

            if (connectionErrorCount >= CONNECTION_ERROR_VISIBLE_LIMIT) {
                renderConnectionError();
            }
        }
    }

    function handleInactiveBackendSession(summary) {
        if (sessionEnded) {
            return;
        }

        sessionEnded = true;
        pauseElapsedTimer();
        stopPolling();

        utils.markMonitoringSessionStopped(summary);
        unlockBrowserBackGuard();

        utils.redirectTo("summary.html", { replace: true });
    }

    /* =========================
       Elapsed Time
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

        return status === "good" || status === "bad";
    }

    function pauseElapsedTimer() {
        elapsedCountingActive = false;
        lastElapsedTick = Date.now();
    }

    function syncElapsedTimeFromSummary(summary) {
        const backendSeconds = Number(summary.effective_seated_seconds);

        if (!Number.isFinite(backendSeconds) || backendSeconds < 0) {
            return;
        }

        if (backendSeconds > displayedElapsedSeconds) {
            displayedElapsedSeconds = backendSeconds;
        }

        lastElapsedTick = Date.now();
        setText("elapsedTime", formatTime(displayedElapsedSeconds));
    }

    function updateElapsedTime() {
        if (sessionEnded) {
            return;
        }

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

        if (delta > 0 && delta <= 5) {
            displayedElapsedSeconds += delta;
        }

        setText("elapsedTime", formatTime(displayedElapsedSeconds));
    }

    /* =========================
       Render
    ========================= */

    function renderConnectionError() {
        const cameraStatus = $("cameraStatus");

        if (cameraStatus) {
            cameraStatus.textContent = "เชื่อมต่อ backend ไม่ได้";
            cameraStatus.classList.add("is-error");
            cameraStatus.classList.remove("is-active");
        }

        const statusCard = $("statusCard");

        if (statusCard) {
            statusCard.className = "status-card is-waiting";
        }

        setText("statusBadge", "รอการเชื่อมต่อ");
        setText("statusMessage", "Backend connection failed");
        setText(
            "currentAdvice",
            "ตรวจสอบว่า backend เปิดอยู่ แล้วรอสักครู่หรือ refresh หน้าอีกครั้ง ระบบจะยังไม่ล้าง session ทันที"
        );
    }

    function renderPosture(posture) {
        const status = posture.status || "no_person_detected";

        const statusMap = {
            good: {
                label: "ปกติ",
                className: "is-good",
                message: "ท่าทางอยู่ในเกณฑ์ปกติ",
                advice: "รักษาศีรษะและไหล่ให้อยู่ในแนวที่สบาย",
            },
            bad: {
                label: "ควรปรับท่าทาง",
                className: "is-bad",
                message: "ตรวจพบแนวโน้มท่าทางเสี่ยง",
                advice: "ระบบกำลังจับเวลาต่อเนื่องก่อนแจ้งเตือนจริง",
            },
            paused: {
                label: "หยุดชั่วคราว",
                className: "is-waiting",
                message: "Session paused",
                advice: "จัดตำแหน่งให้อยู่ในกรอบกล้อง",
            },
            no_person_detected: {
                label: "ไม่พบผู้ใช้งาน",
                className: "is-waiting",
                message: "No person detected",
                advice: "กรุณานั่งให้อยู่ในกรอบกล้อง",
            },
            marker_not_detected: {
                label: "ไม่พบข้อมูลท่าทาง",
                className: "is-waiting",
                message: "Landmark not detected",
                advice: "ตรวจสอบแสงและตำแหน่งกล้อง",
            },
        };

        const item = statusMap[status] || statusMap.no_person_detected;
        const statusCard = $("statusCard");

        if (statusCard) {
            statusCard.className = `status-card ${item.className}`;
        }

        setText("statusBadge", item.label);
        setText("statusMessage", item.message);
        setText("currentAdvice", buildCurrentAdvice(posture, item.advice));

        renderIssueCards(posture);
    }

    function renderIssueCards(posture) {
        const cva = normalizeNumber(posture.cva_angle);
        const fsa = normalizeNumber(posture.fsa_angle);

        const forwardDuration = normalizeNumber(posture.forward_head_duration) || 0;
        const roundedDuration = normalizeNumber(posture.rounded_shoulder_duration) || 0;

        setText("cvaValue", formatMetric(posture.cva_angle));
        setText("fsaValue", formatMetric(posture.fsa_angle));
        setText("cvaTimer", formatTime(forwardDuration));
        setText("fsaTimer", formatTime(roundedDuration));
        setText("cvaHint", getCvaHint(posture));
        setText("fsaHint", getFsaHint(posture));

        updateIssueCard({
            cardId: "cvaCard",
            stateId: "cvaIssueState",
            barId: "cvaTimerBar",
            hasValue: Number.isFinite(cva),
            isBad: posture.is_forward_head === true,
            isActive: posture.forward_head_alert_active === true,
            duration: forwardDuration,
            normalText: "ปกติ",
            warningText: "กำลังจับเวลา",
            dangerText: "แจ้งเตือนแล้ว",
        });

        updateIssueCard({
            cardId: "fsaCard",
            stateId: "fsaIssueState",
            barId: "fsaTimerBar",
            hasValue: Number.isFinite(fsa),
            isBad: posture.is_rounded_shoulder === true,
            isActive: posture.rounded_shoulder_alert_active === true,
            duration: roundedDuration,
            normalText: "ปกติ",
            warningText: "กำลังจับเวลา",
            dangerText: "แจ้งเตือนแล้ว",
        });
    }

    function updateIssueCard(options) {
        const {
            cardId,
            stateId,
            barId,
            hasValue,
            isBad,
            isActive,
            duration,
            normalText,
            warningText,
            dangerText,
        } = options;

        const card = $(cardId);

        if (card) {
            card.classList.remove("is-normal", "is-warning", "is-danger");

            if (!hasValue) {
                card.classList.add("is-warning");
            } else if (isActive) {
                card.classList.add("is-danger");
            } else if (isBad) {
                card.classList.add("is-warning");
            } else {
                card.classList.add("is-normal");
            }
        }

        if (!hasValue) {
            setText(stateId, "ยังไม่มีข้อมูล");
            setWidth(barId, "0%");
            return;
        }

        if (isActive) {
            setText(stateId, dangerText);
        } else if (isBad) {
            setText(stateId, warningText);
        } else {
            setText(stateId, normalText);
        }

        const progress =
            isBad || isActive
                ? Math.min((Number(duration || 0) / ALERT_DURATION_SECONDS) * 100, 100)
                : 0;

        setWidth(barId, `${progress.toFixed(0)}%`);
    }

    function renderStats(summary) {
        syncElapsedTimeFromSummary(summary);

        const goodSeconds = Number(summary.good_posture_seconds || 0);
        const forwardAlertCount = Number(summary.forward_head_alert_count || 0);
        const roundedAlertCount = Number(summary.rounded_shoulder_alert_count || 0);
        const alertCount = Number(summary.alert_count || 0);

        setText("goodTime", formatTime(goodSeconds));
        setText("forwardHeadAlertCount", `${forwardAlertCount} ครั้ง`);
        setText("roundedShoulderAlertCount", `${roundedAlertCount} ครั้ง`);
        setText("alertCount", `${alertCount} ครั้ง`);
    }

    /* =========================
       Alert
    ========================= */

    function handleAlertEvent(posture) {
        const now = Date.now();

        const forwardHeadAlert = posture.forward_head_alert === true;
        const roundedShoulderAlert = posture.rounded_shoulder_alert === true;

        const forwardHeadAlertActive = posture.forward_head_alert_active === true;
        const roundedShoulderAlertActive = posture.rounded_shoulder_alert_active === true;

        const directAlert =
            posture.alert === true || forwardHeadAlert || roundedShoulderAlert;

        const becameForwardHeadActive =
            forwardHeadAlertActive && !lastForwardHeadAlertActive;

        const becameRoundedShoulderActive =
            roundedShoulderAlertActive && !lastRoundedShoulderAlertActive;

        lastForwardHeadAlertActive = forwardHeadAlertActive;
        lastRoundedShoulderAlertActive = roundedShoulderAlertActive;

        const shouldNotify =
            directAlert || becameForwardHeadActive || becameRoundedShoulderActive;

        if (!shouldNotify) {
            return;
        }

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

    function showBrowserNotification(message) {
        if (!notificationEnabled) return;
        if (!("Notification" in window)) return;
        if (Notification.permission !== "granted") return;

        try {
            new Notification("PostureGuard AI", {
                body: message || "กรุณาปรับท่านั่งให้อยู่ในท่าที่เหมาะสม",
                silent: false,
            });
        } catch (err) {
            console.warn("Cannot show browser notification:", err);
        }
    }

    function buildPostureAlertMessage(posture) {
        const issues = [];

        if (
            posture.forward_head_alert === true ||
            posture.forward_head_alert_active === true
        ) {
            issues.push("ท่านั่งของคุณมีแนวโน้มคอยื่น");
        }

        if (
            posture.rounded_shoulder_alert === true ||
            posture.rounded_shoulder_alert_active === true
        ) {
            issues.push("ท่านั่งของคุณมีแนวโน้มไหล่ห่อ");
        }

        if (issues.length === 0) {
            return posture.message || "กรุณาปรับท่านั่งให้อยู่ในท่าที่เหมาะสม";
        }

        return `${issues.join(" และ ")} กรุณาปรับศีรษะ ไหล่ และหลังส่วนบนให้อยู่ในท่าที่ผ่อนคลาย`;
    }

    function buildCurrentAdvice(posture, fallback) {
        const issues = [];

        if (posture.is_forward_head === true) {
            const duration = Number(posture.forward_head_duration || 0);

            issues.push(
                posture.forward_head_alert_active === true
                    ? "คอยื่น: แจ้งเตือนแล้ว"
                    : `คอยื่น ${formatTime(duration)}`
            );
        }

        if (posture.is_rounded_shoulder === true) {
            const duration = Number(posture.rounded_shoulder_duration || 0);

            issues.push(
                posture.rounded_shoulder_alert_active === true
                    ? "ไหล่ห่อ: แจ้งเตือนแล้ว"
                    : `ไหล่ห่อ ${formatTime(duration)}`
            );
        }

        if (issues.length > 0) {
            return `${issues.join(" | ")} · กรุณาปรับท่านั่งให้อยู่ในแนวที่เหมาะสม`;
        }

        return fallback || "ระบบกำลังวิเคราะห์ท่าทาง";
    }

    /* =========================
       Hints
    ========================= */

    function getCvaHint(posture) {
        const cva = normalizeNumber(posture.cva_angle);

        if (!Number.isFinite(cva)) {
            return "อ่านค่าไม่ได้";
        }

        if (cva >= CVA_NORMAL_THRESHOLD) {
            return "อยู่ในเกณฑ์ปกติ";
        }

        if (posture.forward_head_alert_active === true) {
            return "แจ้งเตือนแล้ว";
        }

        return `ต่ำกว่าเกณฑ์ · จับเวลา ${formatTime(posture.forward_head_duration || 0)}`;
    }

    function getFsaHint(posture) {
        const fsa = normalizeNumber(posture.fsa_angle);

        if (!Number.isFinite(fsa)) {
            return "อ่านค่าไม่ได้";
        }

        if (fsa >= FSA_NORMAL_THRESHOLD) {
            return "อยู่ในเกณฑ์ปกติ";
        }

        if (posture.rounded_shoulder_alert_active === true) {
            return "แจ้งเตือนแล้ว";
        }

        return `ต่ำกว่าเกณฑ์ · จับเวลา ${formatTime(posture.rounded_shoulder_duration || 0)}`;
    }

    /* =========================
       Stop Session
    ========================= */

    async function stopSession() {
        if (sessionEnded || isStopping) {
            return;
        }

        isStopping = true;
        sessionEnded = true;

        pauseElapsedTimer();
        stopPolling();
        setStopButtonLoading(true);

        setText("statusBadge", "กำลังสรุปผล");
        setText("statusMessage", "Stopping monitoring session");
        setText("currentAdvice", "กรุณารอสักครู่ ระบบกำลังบันทึกและสรุปผลการใช้งาน");

        try {
            if (window.alertSpeech) {
                window.alertSpeech.disable();
            }

            const summary = await api.stopSession();

            try {
                await api.stopCamera();
            } catch (err) {
                console.warn("Cannot stop camera:", err);
            }

            utils.markMonitoringSessionStopped(summary);
            unlockBrowserBackGuard();

            utils.redirectTo("summary.html", { replace: true });
        } catch (err) {
            console.warn("Stop session error:", err);

            const recovered = await recoverFromStopSessionError(err);

            if (recovered) {
                return;
            }

            alert(
                "หยุด session ไม่สำเร็จ\n\n" +
                "สาเหตุ: " + err.message + "\n\n" +
                "กรุณาตรวจสอบว่า backend ยังทำงานอยู่ แล้วลองกดหยุดอีกครั้ง"
            );

            isStopping = false;
            sessionEnded = false;

            setStopButtonLoading(false);
            startPolling();
        }
    }

    async function recoverFromStopSessionError(err) {
        const message = String(err?.message || "");

        if (!message.includes("No active session")) {
            return false;
        }

        try {
            const summary = await api.getSessionSummary();

            try {
                await api.stopCamera();
            } catch (cameraErr) {
                console.warn("Cannot stop camera while recovering:", cameraErr);
            }

            utils.markMonitoringSessionStopped(summary);
            unlockBrowserBackGuard();

            utils.redirectTo("summary.html", { replace: true });
            return true;
        } catch (summaryErr) {
            console.warn("Cannot recover stop session error:", summaryErr);
            return false;
        }
    }

    /* =========================
       Utilities
    ========================= */

    function normalizeNumber(value) {
        if (value === null || value === undefined || value === "") {
            return NaN;
        }

        const n = Number(value);

        return Number.isFinite(n) ? n : NaN;
    }

    function formatMetric(value) {
        const n = normalizeNumber(value);

        if (!Number.isFinite(n)) {
            return "—";
        }

        return n.toFixed(1);
    }

    function formatTime(totalSeconds) {
        const s = Math.max(0, Math.floor(Number(totalSeconds) || 0));
        const h = Math.floor(s / 3600);
        const m = Math.floor((s % 3600) / 60);
        const sec = s % 60;

        if (h > 0) {
            return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
        }

        return `${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
    }

    function setWidth(id, value) {
        const el = $(id);

        if (!el) {
            return;
        }

        el.style.width = value;
    }

    function setText(id, value) {
        const el = $(id);

        if (!el) {
            return;
        }

        const text = String(value);

        if (el.textContent !== text) {
            el.textContent = text;
        }
    }
})();