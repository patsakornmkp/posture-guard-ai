/* =========================================
   Monitoring Page
   File: frontend/js/monitoring.js

   ใช้กับหน้า realtime monitoring ของ PostureGuard AI
   - ใช้ CVA สำหรับคอยื่น
   - ใช้ FSA สำหรับไหล่ห่อ
   - ไม่มี Calibration / Baseline
   - ไม่มี hunched back / kyphosis
   - มี Settings Panel: เสียง / Browser / LINE
   - มี Chart Panel: กราฟ CVA / FSA
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

    let angleHistory = [];

    const VIDEO_FRAME_INTERVAL = 700;
    const POSTURE_POLL_INTERVAL = 1500;
    const ELAPSED_INTERVAL = 1000;
    const FRONTEND_ALERT_COOLDOWN = 5000;
    const ALERT_DURATION_SECONDS = 180;
    const CONNECTION_ERROR_VISIBLE_LIMIT = 1;

    const CVA_NORMAL_THRESHOLD = 50;
    const FSA_NORMAL_THRESHOLD = 54;

    const MAX_CHART_POINTS = 60;

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
        setupStopButton();

        setupSettingsPanel();
        setupChartPanel();

        setupSpeechToggle();
        setupNotificationToggle();
        setupLineToggle();

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
        angleHistory = [];

        setText("elapsedTime", formatTime(0));

        setText("goodPostureRatio", "0%");
        setText("riskPostureRatio", "0%");
        setText("forwardHeadDuration", "00:00");
        setText("roundedShoulderDuration", "00:00");
        setText("alertCount", "0 ครั้ง");

        // เผื่อ HTML เก่ายังมี id เดิม
        setText("goodTime", formatTime(0));
        setText("forwardHeadAlertCount", "0 ครั้ง");
        setText("roundedShoulderAlertCount", "0 ครั้ง");
    }

    function renderInitialLoadingState() {
        const cameraStatus = $("cameraStatus");

        if (cameraStatus) {
            cameraStatus.textContent = "กำลังเชื่อมต่อกล้อง...";
            cameraStatus.classList.remove("is-active", "is-ready", "is-error");
        }

        const statusCard = $("statusCard");

        if (statusCard) {
            statusCard.className = "status-card is-waiting";
        }

        setText("statusBadge", "กำลังเริ่มระบบ");
        setText("statusMessage", "Loading monitoring session");
        setText("currentAdvice", "ระบบกำลังวิเคราะห์ท่าทางจากกล้อง");
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

        showToast("กรุณากดหยุดการใช้งานก่อนออกจากหน้านี้");
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
       Setup Buttons / Panels
    ========================= */

    function setupStopButton() {
        const stopBtn = $("stopBtn");

        if (!stopBtn) {
            return;
        }

        stopBtn.disabled = false;
        stopBtn.textContent = "⏹ หยุดการใช้งาน";

        stopBtn.addEventListener("click", () => {
            stopSession();
        });
    }

    function setStopButtonLoading(isLoading) {
        const stopBtn = $("stopBtn");

        if (!stopBtn) {
            return;
        }

        stopBtn.disabled = isLoading;
        stopBtn.textContent = isLoading ? "กำลังหยุด..." : "⏹ หยุดการใช้งาน";
    }

    function setupSettingsPanel() {
        const settingsBtn = $("settingsBtn");
        const settingsPanel = $("settingsPanel");
        const settingsOverlay = $("settingsOverlay");
        const settingsCloseBtn = $("settingsCloseBtn");

        if (!settingsBtn || !settingsPanel || !settingsOverlay || !settingsCloseBtn) {
            return;
        }

        settingsBtn.addEventListener("click", () => {
            openPanel(settingsPanel, settingsOverlay, settingsCloseBtn);
        });

        settingsCloseBtn.addEventListener("click", () => {
            closePanel(settingsPanel, settingsOverlay, settingsBtn);
        });

        settingsOverlay.addEventListener("click", () => {
            closePanel(settingsPanel, settingsOverlay, settingsBtn);
        });

        document.addEventListener("keydown", (event) => {
            if (event.key === "Escape" && !settingsPanel.hidden) {
                closePanel(settingsPanel, settingsOverlay, settingsBtn);
            }
        });
    }

    function setupChartPanel() {
        const chartOpenBtn = $("chartOpenBtn");
        const chartPanel = $("chartPanel");
        const chartOverlay = $("chartOverlay");
        const chartCloseBtn = $("chartCloseBtn");

        if (!chartOpenBtn || !chartPanel || !chartOverlay || !chartCloseBtn) {
            return;
        }

        chartOpenBtn.addEventListener("click", () => {
            drawAngleChart();
            openPanel(chartPanel, chartOverlay, chartCloseBtn);
        });

        chartCloseBtn.addEventListener("click", () => {
            closePanel(chartPanel, chartOverlay, chartOpenBtn);
        });

        chartOverlay.addEventListener("click", () => {
            closePanel(chartPanel, chartOverlay, chartOpenBtn);
        });

        document.addEventListener("keydown", (event) => {
            if (event.key === "Escape" && !chartPanel.hidden) {
                closePanel(chartPanel, chartOverlay, chartOpenBtn);
            }
        });
    }

    function openPanel(panel, overlay, focusTarget = null) {
        panel.hidden = false;
        overlay.hidden = false;

        if (focusTarget) {
            window.setTimeout(() => focusTarget.focus(), 0);
        }
    }

    function closePanel(panel, overlay, focusTarget = null) {
        panel.hidden = true;
        overlay.hidden = true;

        if (focusTarget) {
            window.setTimeout(() => focusTarget.focus(), 0);
        }
    }

    /* =========================
       Camera
    ========================= */

    function setupVideoStatus() {
        const video = $("videoFeed");
        const cameraStatus = $("cameraStatus");

        if (!video || !cameraStatus) {
            return;
        }

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

    /* =========================
       Notification Settings
    ========================= */

    function setupSpeechToggle() {
        const toggle = $("speechToggleBtn");
        const desc = $("soundDesc");

        if (!toggle) {
            return;
        }

        if (!window.alertSpeech) {
            toggle.checked = false;
            toggle.disabled = true;

            if (desc) {
                desc.textContent = "ไม่รองรับ";
            }

            return;
        }

        toggle.checked = false;

        if (desc) {
            desc.textContent = "ปิดอยู่";
        }

        toggle.addEventListener("change", () => {
            if (toggle.checked) {
                if (typeof window.alertSpeech.enable === "function") {
                    window.alertSpeech.enable();
                }

                if (desc) {
                    desc.textContent = "เปิดอยู่";
                }

                showToast("เปิดแจ้งเตือนเสียงแล้ว");
            } else {
                if (typeof window.alertSpeech.disable === "function") {
                    window.alertSpeech.disable();
                }

                if (desc) {
                    desc.textContent = "ปิดอยู่";
                }

                showToast("ปิดแจ้งเตือนเสียงแล้ว");
            }
        });
    }

    function setupNotificationToggle() {
        const toggle = $("notifyToggleBtn");
        const desc = $("notifyDesc");

        if (!toggle) {
            return;
        }

        if (!("Notification" in window)) {
            notificationEnabled = false;
            toggle.checked = false;
            toggle.disabled = true;

            if (desc) {
                desc.textContent = "ไม่รองรับ";
            }

            return;
        }

        if (!window.isSecureContext) {
            notificationEnabled = false;
            toggle.checked = false;
            toggle.disabled = true;

            if (desc) {
                desc.textContent = "ต้องใช้ localhost/HTTPS";
            }

            return;
        }

        if (Notification.permission === "granted") {
            notificationEnabled = true;
            toggle.checked = true;

            if (desc) {
                desc.textContent = "เปิดอยู่";
            }
        } else if (Notification.permission === "denied") {
            notificationEnabled = false;
            toggle.checked = false;

            if (desc) {
                desc.textContent = "ถูกบล็อก";
            }
        } else {
            notificationEnabled = false;
            toggle.checked = false;

            if (desc) {
                desc.textContent = "กดเพื่อเปิด";
            }
        }

        toggle.addEventListener("change", async () => {
            if (toggle.checked) {
                const granted = await requestNotificationPermission();

                notificationEnabled = granted;
                toggle.checked = granted;

                if (desc) {
                    desc.textContent = granted ? "เปิดอยู่" : "ยังไม่อนุญาต";
                }

                showToast(granted ? "เปิด Browser Notification แล้ว" : "ยังไม่ได้รับอนุญาต");
            } else {
                notificationEnabled = false;

                if (desc) {
                    desc.textContent = "ปิดอยู่";
                }

                showToast("ปิด Browser Notification แล้ว");
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

    async function setupLineToggle() {
        const toggle = $("lineToggleBtn");
        const desc = $("lineDesc");

        if (!toggle || !desc) {
            return;
        }

        toggle.checked = false;
        toggle.disabled = true;
        desc.textContent = "กำลังตรวจสอบ...";

        try {
            const status = await fetchLineStatus();

            renderLineStatus(status);

            toggle.addEventListener("change", async () => {
                const nextEnabled = toggle.checked;

                toggle.disabled = true;
                desc.textContent = "กำลังอัปเดต...";

                try {
                    const updated = await setLineEnabled(nextEnabled);

                    renderLineStatus(updated);
                    showToast(nextEnabled ? "เปิดแจ้งเตือน LINE แล้ว" : "ปิดแจ้งเตือน LINE แล้ว");
                } catch (err) {
                    console.warn("Cannot update LINE notification:", err);

                    toggle.checked = !nextEnabled;
                    desc.textContent = "อัปเดตไม่สำเร็จ";
                    showToast("ยังไม่สามารถเปิด/ปิด LINE ได้");
                } finally {
                    const latest = await fetchLineStatusSafe();

                    if (latest) {
                        renderLineStatus(latest);
                    }
                }
            });
        } catch (err) {
            console.warn("Cannot load LINE status:", err);

            toggle.checked = false;
            toggle.disabled = true;
            desc.textContent = "เชื่อมต่อไม่ได้";
        }
    }

    function renderLineStatus(status) {
        const toggle = $("lineToggleBtn");
        const desc = $("lineDesc");

        if (!toggle || !desc || !status) {
            return;
        }

        const hasToken = status.has_channel_access_token === true;
        const hasSecret = status.has_channel_secret === true;
        const hasUserId = status.has_line_user_id === true;
        const enabled = status.line_enabled === true;

        const ready = hasToken && hasSecret && hasUserId;

        toggle.checked = enabled;

        if (!ready) {
            toggle.disabled = true;
            desc.textContent = "ตั้งค่าไม่ครบ";
            return;
        }

        toggle.disabled = false;
        desc.textContent = enabled ? "เปิดอยู่" : "ปิดอยู่";
    }

    async function fetchLineStatusSafe() {
        try {
            return await fetchLineStatus();
        } catch (_) {
            return null;
        }
    }

    async function fetchLineStatus() {
        const response = await fetch(`${utils.API_BASE}/notification/line/status`, {
            method: "GET",
            headers: {
                "Content-Type": "application/json",
            },
        });

        if (!response.ok) {
            throw new Error(`LINE status error ${response.status}`);
        }

        return response.json();
    }

    async function setLineEnabled(enabled) {
        const response = await fetch(`${utils.API_BASE}/notification/line/enabled`, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
            },
            body: JSON.stringify({ enabled }),
        });

        const contentType = response.headers.get("content-type") || "";
        const data = contentType.includes("application/json")
            ? await response.json()
            : null;

        if (!response.ok) {
            throw new Error(data?.detail || `LINE update error ${response.status}`);
        }

        return data;
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

            const safePosture = posture || {};
            const safeSummary = summary || {};

            updateElapsedCountingState(safePosture);
            appendAnglePoint(safePosture);

            renderPosture(safePosture);
            renderStats(safeSummary);
            handleAlertEvent(safePosture);
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
        setText("currentAdvice", "ตรวจสอบว่า backend เปิดอยู่");
    }

    function renderPosture(posture) {
        const status = posture.status || "no_person_detected";

        const statusMap = {
            good: {
                label: "ปกติ",
                className: "is-good",
                message: "ท่าทางอยู่ในเกณฑ์ปกติ",
                advice: "รักษาท่านั่งให้อยู่ในแนวที่เหมาะสม",
            },
            bad: {
                label: "ควรปรับท่าทาง",
                className: "is-bad",
                message: "ตรวจพบแนวโน้มท่าทางเสี่ยง",
                advice: "ระบบกำลังจับเวลาต่อเนื่อง",
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

        renderIssueValues(posture);
    }

    function renderIssueValues(posture) {
        const cva = normalizeNumber(posture.cva_angle);
        const fsa = normalizeNumber(posture.fsa_angle);

        setText("cvaValue", formatMetric(posture.cva_angle));
        setText("fsaValue", formatMetric(posture.fsa_angle));

        setText("cvaHint", getCvaHint(posture));
        setText("fsaHint", getFsaHint(posture));

        // เผื่อ HTML เก่ายังมี id เหล่านี้
        setText("cvaTimer", formatTime(posture.forward_head_duration || 0));
        setText("fsaTimer", formatTime(posture.rounded_shoulder_duration || 0));

        if (!Number.isFinite(cva)) {
            setText("cvaHint", "อ่านค่าไม่ได้");
        }

        if (!Number.isFinite(fsa)) {
            setText("fsaHint", "อ่านค่าไม่ได้");
        }
    }

    function renderStats(summary) {
        syncElapsedTimeFromSummary(summary);

        const effective = Number(summary.effective_seated_seconds || 0);
        const good = Number(summary.good_posture_seconds || 0);
        const forward = Number(summary.forward_head_seconds || 0);
        const rounded = Number(summary.rounded_shoulder_seconds || 0);

        const forwardAlertCount = Number(summary.forward_head_alert_count || 0);
        const roundedAlertCount = Number(summary.rounded_shoulder_alert_count || 0);
        const alertCount = Number(summary.alert_count || 0);

        const goodPct = percent(good, effective);
        const riskPct = Math.max(0, 100 - goodPct);

        setText("goodPostureRatio", `${goodPct.toFixed(0)}%`);
        setText("riskPostureRatio", `${riskPct.toFixed(0)}%`);
        setText("forwardHeadDuration", formatTime(forward));
        setText("roundedShoulderDuration", formatTime(rounded));
        setText("alertCount", `${alertCount} ครั้ง`);

        // เผื่อ HTML เก่ายังมี id เดิม
        setText("goodTime", formatTime(good));
        setText("forwardHeadAlertCount", `${forwardAlertCount} ครั้ง`);
        setText("roundedShoulderAlertCount", `${roundedAlertCount} ครั้ง`);
    }

    function buildCurrentAdvice(posture, fallback) {
        const issues = [];

        if (posture.is_forward_head === true) {
            const duration = Number(posture.forward_head_duration || 0);
            issues.push(`คอยื่น ${formatTime(duration)}`);
        }

        if (posture.is_rounded_shoulder === true) {
            const duration = Number(posture.rounded_shoulder_duration || 0);
            issues.push(`ไหล่ห่อ ${formatTime(duration)}`);
        }

        if (issues.length > 0) {
            return issues.join(" · ");
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

        return `ต่ำกว่าเกณฑ์ · ${formatTime(posture.forward_head_duration || 0)}`;
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

        return `ต่ำกว่าเกณฑ์ · ${formatTime(posture.rounded_shoulder_duration || 0)}`;
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

        if (window.alertSpeech && typeof window.alertSpeech.speak === "function") {
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
            issues.push("มีแนวโน้มคอยื่น");
        }

        if (
            posture.rounded_shoulder_alert === true ||
            posture.rounded_shoulder_alert_active === true
        ) {
            issues.push("มีแนวโน้มไหล่ห่อ");
        }

        if (issues.length === 0) {
            return posture.message || "กรุณาปรับท่านั่งให้อยู่ในท่าที่เหมาะสม";
        }

        return `${issues.join(" และ ")} กรุณาปรับท่านั่ง`;
    }

    /* =========================
       Chart
    ========================= */

    function appendAnglePoint(posture) {
        const cva = normalizeNumber(posture.cva_angle);
        const fsa = normalizeNumber(posture.fsa_angle);

        if (!Number.isFinite(cva) && !Number.isFinite(fsa)) {
            return;
        }

        angleHistory.push({
            t: displayedElapsedSeconds,
            cva: Number.isFinite(cva) ? cva : null,
            fsa: Number.isFinite(fsa) ? fsa : null,
        });

        if (angleHistory.length > MAX_CHART_POINTS) {
            angleHistory.shift();
        }
    }

    function drawAngleChart() {
        const svg = $("angleChartSvg");

        if (!svg) {
            return;
        }

        svg.innerHTML = "";

        if (angleHistory.length < 2) {
            svg.innerHTML = `
                <text x="380" y="165" text-anchor="middle" class="chart-empty-text">
                    ยังไม่มีข้อมูลเพียงพอสำหรับแสดงกราฟ
                </text>
            `;
            return;
        }

        const width = 760;
        const height = 330;

        const padding = {
            left: 54,
            right: 36,
            top: 42,
            bottom: 46,
        };

        const chartWidth = width - padding.left - padding.right;
        const chartHeight = height - padding.top - padding.bottom;

        const minAngle = 15;
        const maxAngle = 70;

        const firstTime = angleHistory[0].t || 0;
        const lastTime = angleHistory[angleHistory.length - 1].t || 1;
        const timeSpan = Math.max(lastTime - firstTime, 1);

        const getX = (t) => {
            return padding.left + ((t - firstTime) / timeSpan) * chartWidth;
        };

        const getY = (angle) => {
            const clamped = clamp(angle, minAngle, maxAngle);
            return padding.top + chartHeight - ((clamped - minAngle) / (maxAngle - minAngle)) * chartHeight;
        };

        const gridValues = [20, 30, 40, 50, 60];

        let content = "";

        gridValues.forEach((value) => {
            const y = getY(value);

            content += `
                <line x1="${padding.left}" y1="${y}" x2="${width - padding.right}" y2="${y}"
                    stroke="rgba(0,0,0,0.08)" stroke-width="1" />
                <text x="14" y="${y + 4}" font-size="12" fill="#8a9390">${value}°</text>
            `;
        });

        const cvaThresholdY = getY(CVA_NORMAL_THRESHOLD);
        const fsaThresholdY = getY(FSA_NORMAL_THRESHOLD);

        content += `
            <line x1="${padding.left}" y1="${cvaThresholdY}" x2="${width - padding.right}" y2="${cvaThresholdY}"
                stroke="#d49a16" stroke-width="2" stroke-dasharray="8 8" opacity="0.6" />
            <line x1="${padding.left}" y1="${fsaThresholdY}" x2="${width - padding.right}" y2="${fsaThresholdY}"
                stroke="#1d9e75" stroke-width="2" stroke-dasharray="8 8" opacity="0.55" />
        `;

        const cvaPath = buildLinePath(angleHistory, "cva", getX, getY);
        const fsaPath = buildLinePath(angleHistory, "fsa", getX, getY);

        if (cvaPath) {
            content += `
                <path d="${cvaPath}" fill="none" stroke="#d49a16"
                    stroke-width="4" stroke-linecap="round" stroke-linejoin="round" />
            `;
        }

        if (fsaPath) {
            content += `
                <path d="${fsaPath}" fill="none" stroke="#1d9e75"
                    stroke-width="4" stroke-linecap="round" stroke-linejoin="round" />
            `;
        }

        angleHistory.forEach((point) => {
            const x = getX(point.t);

            if (point.cva !== null) {
                content += `<circle cx="${x}" cy="${getY(point.cva)}" r="4" fill="#d49a16" />`;
            }

            if (point.fsa !== null) {
                content += `<circle cx="${x}" cy="${getY(point.fsa)}" r="4" fill="#1d9e75" />`;
            }
        });

        content += buildTimeLabels({
            width,
            height,
            padding,
            firstTime,
            lastTime,
            getX,
        });

        svg.innerHTML = content;
    }

    function buildLinePath(points, key, getX, getY) {
        const valid = points.filter((p) => p[key] !== null && Number.isFinite(p[key]));

        if (valid.length < 2) {
            return "";
        }

        return valid
            .map((p, index) => {
                const x = getX(p.t);
                const y = getY(p[key]);

                return `${index === 0 ? "M" : "L"} ${x} ${y}`;
            })
            .join(" ");
    }

    function buildTimeLabels({ height, padding, firstTime, lastTime, getX }) {
        const labels = [];
        const total = Math.max(lastTime - firstTime, 1);

        for (let i = 0; i <= 3; i++) {
            const t = firstTime + (total * i) / 3;
            const x = getX(t);

            labels.push(`
                <text x="${x}" y="${height - 14}" text-anchor="middle"
                    font-size="12" fill="#8a9390">
                    ${formatTime(t)}
                </text>
            `);
        }

        return labels.join("");
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
        setText("currentAdvice", "ระบบกำลังบันทึกและสรุปผล");

        try {
            if (window.alertSpeech && typeof window.alertSpeech.disable === "function") {
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
       Toast
    ========================= */

    function showToast(message) {
        const toast = $("monitoringToast");

        if (!toast) {
            return;
        }

        toast.textContent = message;
        toast.hidden = false;

        clearTimeout(showToast.timer);

        showToast.timer = setTimeout(() => {
            toast.hidden = true;
        }, 1600);
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

    function percent(value, total) {
        const n = Number(value || 0);
        const t = Number(total || 0);

        if (t <= 0) {
            return 0;
        }

        return (n / t) * 100;
    }

    function clamp(value, min, max) {
        return Math.max(min, Math.min(max, value));
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