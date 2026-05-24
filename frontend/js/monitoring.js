/* =========================================
   PostureGuard AI - Monitoring Page
   Clean Compact Production Version
   File: frontend/js/monitoring.js

   - ใช้ CVA ตรวจคอยื่น
   - ใช้ FSA ตรวจไหล่ห่อ
   - ไม่มี Calibration / Baseline
   - ไม่มี hunched back / kyphosis
   - ไม่มีกราฟในหน้า Monitoring
   - ไม่มี stats modal / stats button
   - Summary เป็น popover ข้างปุ่มตั้งค่า
   - Settings เป็น popover ขนาดจำกัด ไม่ล้นจอ
   - Browser notification ไม่เด้งบัง UI ตอนผู้ใช้เปิดหน้าเว็บอยู่
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
    let currentRiskInFrame = false;

    const VIDEO_FRAME_INTERVAL = 700;
    const POSTURE_POLL_INTERVAL = 1500;
    const ELAPSED_INTERVAL = 1000;
    const FRONTEND_ALERT_COOLDOWN = 45000;
    const CONNECTION_ERROR_VISIBLE_LIMIT = 1;

    const CVA_NORMAL_THRESHOLD = 43;
    const FSA_NORMAL_THRESHOLD = 54;

    const $ = (id) => document.getElementById(id);

    document.addEventListener("DOMContentLoaded", async () => {
        if (!window.api || !window.utils) {
            alert("ระบบ frontend โหลดไม่ครบ กรุณาตรวจสอบว่าโหลด app.js ก่อน monitoring.js");
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
        setupSummaryPanel();
        setupSettingsPanel();
        setupSharedPanelEvents();

        setupSpeechToggle();
        setupNotificationToggle();
        setupLineToggle();

        startPolling();
    });

    function resetLocalState() {
        sessionEnded = false;
        videoFrameLoading = false;
        isStopping = false;

        notificationEnabled = false;
        notificationPermissionAsked = false;
        lastFrontendAlertTime = 0;

        lastForwardHeadAlertActive = false;
        lastRoundedShoulderAlertActive = false;

        displayedElapsedSeconds = 0;
        elapsedCountingActive = false;
        lastElapsedTick = Date.now();

        connectionErrorCount = 0;
        currentRiskInFrame = false;

        setText("elapsedTime", formatTime(0));

        setText("goodPostureRatio", "0%");
        setText("riskPostureRatio", "0%");
        setText("forwardHeadDuration", "00:00");
        setText("roundedShoulderDuration", "00:00");
        setText("alertCount", "0 ครั้ง");

        setStatsNote("");

        // รองรับ id เก่าที่อาจยังเหลือใน HTML รุ่นก่อน
        setText("goodTime", "00:00");
        setText("cvaTimer", "00:00");
        setText("fsaTimer", "00:00");
    }

    function renderInitialLoadingState() {
        const cameraStatus = $("cameraStatus");

        if (cameraStatus) {
            cameraStatus.textContent = "กำลังเชื่อมต่อกล้อง...";
            cameraStatus.classList.remove(
                "is-active",
                "is-live",
                "is-ready",
                "is-error",
                "is-danger",
                "is-warning"
            );
        }

        const statusCard = $("statusCard");

        if (statusCard) {
            statusCard.className = "status-card is-waiting";
        }

        setText("statusBadge", "กำลังเริ่มระบบ");
        setText("statusMessage", "ระบบกำลังเตรียมข้อมูลจากกล้อง");
        setText(
            "currentAdvice",
            "นั่งให้อยู่ในกรอบกล้องด้านข้าง เพื่อให้ระบบอ่านค่า CVA และ FSA ได้ชัดเจน"
        );

        setText("cvaValue", "—");
        setText("fsaValue", "—");
        setText("cvaHint", "กำลังอ่านค่า");
        setText("fsaHint", "กำลังอ่านค่า");

        updateIssueStatus("cva", "waiting");
        updateIssueStatus("fsa", "waiting");
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
       Buttons / Panels
    ========================= */

    function setupStopButton() {
        const stopBtn = $("stopBtn");

        if (!stopBtn) {
            return;
        }

        stopBtn.disabled = false;
        stopBtn.textContent = "หยุดการใช้งาน";

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
        stopBtn.textContent = isLoading ? "กำลังหยุด..." : "หยุดการใช้งาน";
    }

    function setupSummaryPanel() {
        const summaryBtn = $("summaryBtn");
        const summaryPanel = $("summaryPanel");
        const summaryCloseBtn = $("summaryCloseBtn");

        if (!summaryBtn || !summaryPanel || !summaryCloseBtn) {
            return;
        }

        summaryBtn.setAttribute("aria-expanded", "false");

        summaryBtn.addEventListener("click", () => {
            const isOpen = !summaryPanel.hidden;

            if (isOpen) {
                closePanel(summaryPanel, summaryBtn);
                hideOverlayIfNoPanelOpen();
                return;
            }

            closeSettingsPanel();
            openPanel(summaryPanel, summaryBtn, summaryCloseBtn);
        });

        summaryCloseBtn.addEventListener("click", () => {
            closePanel(summaryPanel, summaryBtn, summaryBtn);
            hideOverlayIfNoPanelOpen();
        });
    }

    function setupSettingsPanel() {
        const settingsBtn = $("settingsBtn");
        const settingsPanel = $("settingsPanel");
        const settingsCloseBtn = $("settingsCloseBtn");

        if (!settingsBtn || !settingsPanel || !settingsCloseBtn) {
            return;
        }

        settingsBtn.setAttribute("aria-expanded", "false");

        settingsBtn.addEventListener("click", () => {
            const isOpen = !settingsPanel.hidden;

            if (isOpen) {
                closePanel(settingsPanel, settingsBtn);
                hideOverlayIfNoPanelOpen();
                return;
            }

            closeSummaryPanel();
            openPanel(settingsPanel, settingsBtn, settingsCloseBtn);
        });

        settingsCloseBtn.addEventListener("click", () => {
            closePanel(settingsPanel, settingsBtn, settingsBtn);
            hideOverlayIfNoPanelOpen();
        });
    }

    function setupSharedPanelEvents() {
        const settingsOverlay = $("settingsOverlay");

        if (settingsOverlay) {
            settingsOverlay.addEventListener("click", () => {
                closeAllPanels();
            });
        }

        document.addEventListener("keydown", (event) => {
            if (event.key === "Escape") {
                closeAllPanels();
            }
        });
    }

    function openPanel(panel, triggerButton, focusTarget = null) {
        const settingsOverlay = $("settingsOverlay");

        if (!panel || !triggerButton) {
            return;
        }

        panel.hidden = false;
        triggerButton.setAttribute("aria-expanded", "true");

        if (settingsOverlay) {
            settingsOverlay.hidden = false;
        }

        if (focusTarget) {
            window.setTimeout(() => focusTarget.focus(), 0);
        }
    }

    function closePanel(panel, triggerButton, focusTarget = null) {
        if (!panel || !triggerButton) {
            return;
        }

        panel.hidden = true;
        triggerButton.setAttribute("aria-expanded", "false");

        if (focusTarget) {
            window.setTimeout(() => focusTarget.focus(), 0);
        }
    }

    function closeSummaryPanel() {
        const summaryPanel = $("summaryPanel");
        const summaryBtn = $("summaryBtn");

        if (!summaryPanel || !summaryBtn) {
            return;
        }

        closePanel(summaryPanel, summaryBtn);
    }

    function closeSettingsPanel() {
        const settingsPanel = $("settingsPanel");
        const settingsBtn = $("settingsBtn");

        if (!settingsPanel || !settingsBtn) {
            return;
        }

        closePanel(settingsPanel, settingsBtn);
    }

    function closeAllPanels() {
        closeSummaryPanel();
        closeSettingsPanel();
        hideOverlayIfNoPanelOpen();
    }

    function hideOverlayIfNoPanelOpen() {
        const settingsOverlay = $("settingsOverlay");
        const summaryPanel = $("summaryPanel");
        const settingsPanel = $("settingsPanel");

        if (!settingsOverlay) {
            return;
        }

        const hasOpenPanel =
            (summaryPanel && !summaryPanel.hidden) ||
            (settingsPanel && !settingsPanel.hidden);

        settingsOverlay.hidden = !hasOpenPanel;
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
            if (sessionEnded) {
                return;
            }

            cameraStatus.textContent = "กล้องทำงานอยู่";
            cameraStatus.classList.add("is-active");
            cameraStatus.classList.remove("is-error", "is-danger", "is-warning");
        });

        video.addEventListener("error", () => {
            if (sessionEnded) {
                return;
            }

            cameraStatus.textContent = "ไม่สามารถโหลดภาพจากกล้อง";
            cameraStatus.classList.add("is-error");
            cameraStatus.classList.remove("is-active", "is-live", "is-ready");
        });
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

        setupLineActionButtons();

        if (!toggle || !desc) {
            return;
        }

        toggle.checked = false;
        toggle.disabled = true;
        desc.textContent = "กำลังตรวจสอบ...";

        renderLineWaitingState();

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
                    showToast("ยังไม่สามารถเปิด/ปิด LINE ได้ แต่ระบบ Monitoring ยังทำงานต่อ");

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

            renderLineErrorState(
                "ยังไม่สามารถใช้งาน LINE ได้ในขณะนี้ กรุณาติดต่อผู้ดูแลระบบ"
            );
        }
    }

    function setupLineActionButtons() {
        const linkBtn = $("lineLinkBtn");
        const copyBtn = $("lineCopyBtn");
        const testBtn = $("lineTestBtn");

        if (linkBtn) {
            linkBtn.addEventListener("click", async () => {
                linkBtn.disabled = true;
                linkBtn.textContent = "กำลังสร้างรหัส...";

                hideLineError();

                try {
                    const result = await createLineLinkCode();
                    const status = normalizeLineStatusResponse(result) || result?.line || null;

                    renderLineStatus(status);

                    const code = result?.line_link_code || status?.line_link_code;
                    const qrPayload = result?.qr_payload || result?.line_open_url || status?.qr_payload || status?.line_open_url;

                    renderLineQr({
                        code,
                        qrPayload,
                        lineOpenUrl: result?.line_open_url || status?.line_open_url || qrPayload,
                        expiresAt: result?.line_link_code_expires_at || status?.line_link_code_expires_at,
                    });

                    showToast("สร้างรหัสผูก LINE แล้ว");
                } catch (err) {
                    console.warn("Cannot create LINE link code:", err);
                    renderLineErrorState(
                        "ยังไม่สามารถสร้างรหัสผูก LINE ได้ กรุณาลองใหม่อีกครั้ง"
                    );
                    showToast("สร้างรหัสผูก LINE ไม่สำเร็จ");
                } finally {
                    linkBtn.disabled = false;
                    linkBtn.textContent = "ผูกบัญชี LINE";
                }
            });
        }

        if (copyBtn) {
            copyBtn.addEventListener("click", async () => {
                const code = getLineCodeText();

                if (!code) {
                    showToast("ยังไม่มีรหัสให้คัดลอก");
                    return;
                }

                const copied = await copyText(code);

                showToast(copied ? "คัดลอกรหัสแล้ว" : "คัดลอกไม่สำเร็จ");
            });
        }

        if (testBtn) {
            testBtn.addEventListener("click", async () => {
                testBtn.disabled = true;
                testBtn.textContent = "กำลังทดสอบ...";

                hideLineError();

                try {
                    const result = await testLineNotification();

                    if (result?.success === true) {
                        showToast("ส่งข้อความทดสอบ LINE แล้ว");
                    } else {
                        showToast("ส่ง LINE ไม่สำเร็จ");
                        renderLineErrorState(
                            "ยังส่งข้อความทดสอบไม่ได้ กรุณาตรวจสอบว่าผูกบัญชี LINE แล้วและเปิดแจ้งเตือนอยู่"
                        );
                    }
                } catch (err) {
                    console.warn("Cannot test LINE notification:", err);
                    showToast("ทดสอบ LINE ไม่สำเร็จ");
                    renderLineErrorState(
                        "ยังส่งข้อความทดสอบไม่ได้ กรุณาลองใหม่อีกครั้ง"
                    );
                } finally {
                    testBtn.disabled = false;
                    testBtn.textContent = "ทดสอบ LINE";
                }
            });
        }
    }

    function getCurrentUserId() {
        const user = utils.getCurrentUser ? utils.getCurrentUser() : null;

        if (!user) {
            return null;
        }

        const rawId = user.id ?? user.user_id ?? user.userId;
        const userId = Number(rawId);

        return Number.isInteger(userId) && userId > 0 ? userId : null;
    }

    function getLineCodeText() {
        const codeEl = $("lineLinkCode");
        const code = String(codeEl?.textContent || "").trim();

        if (!code || code.includes("---")) {
            return "";
        }

        return code;
    }

    function renderLineWaitingState() {
        setText("lineStatusText", "กำลังตรวจสอบสถานะการผูกบัญชี LINE");
        setText("lineHelpText", "สแกน QR Code แล้วกดส่งรหัสใน LINE เพื่อผูกบัญชี");

        setLinePill("ตรวจสอบ", "is-waiting");
        setLineError("");
        hideLineQr();
    }

    function renderLineStatus(status) {
        const toggle = $("lineToggleBtn");
        const desc = $("lineDesc");
        const linkBtn = $("lineLinkBtn");
        const testBtn = $("lineTestBtn");

        if (!toggle || !desc || !status) {
            return;
        }

        const systemReady =
            status.system_ready === true ||
            (
                status.system_line_enabled === true &&
                status.has_channel_access_token === true &&
                status.has_channel_secret === true
            );

        const canCreateLinkCode =
            status.can_create_link_code === true ||
            status.has_line_official_account_id === true;

        const isLinked = status.is_linked === true || status.has_line_user_id === true;
        const enabled = status.line_notify_enabled === true || status.line_enabled === true;

        toggle.checked = isLinked && enabled;
        toggle.disabled = !systemReady || !isLinked;

        if (!systemReady) {
            desc.textContent = "ระบบยังไม่พร้อม";
            setText(
                "lineStatusText",
                "ยังไม่สามารถใช้งาน LINE ได้ในขณะนี้ กรุณาติดต่อผู้ดูแลระบบ"
            );
            setText("lineHelpText", "ระบบยังไม่พร้อมสำหรับการแจ้งเตือนผ่าน LINE");
            setLinePill("ยังไม่พร้อม", "is-error");

            if (linkBtn) {
                linkBtn.disabled = true;
            }

            if (testBtn) {
                testBtn.hidden = true;
                testBtn.disabled = true;
            }

            hideLineQr();
            return;
        }

        if (!canCreateLinkCode && !isLinked) {
            desc.textContent = "ระบบยังไม่พร้อม";
            setText(
                "lineStatusText",
                "ยังไม่สามารถใช้งาน LINE ได้ในขณะนี้ กรุณาติดต่อผู้ดูแลระบบ"
            );
            setText("lineHelpText", "ยังไม่ได้ตั้งค่าบัญชี LINE Official Account");
            setLinePill("ยังไม่พร้อม", "is-error");

            if (linkBtn) {
                linkBtn.disabled = true;
            }

            if (testBtn) {
                testBtn.hidden = true;
                testBtn.disabled = true;
            }

            hideLineQr();
            return;
        }

        if (!isLinked) {
            desc.textContent = "ยังไม่ได้ผูก";
            setText("lineStatusText", "ยังไม่ได้ผูกบัญชี LINE");
            setText(
                "lineHelpText",
                "สแกน QR Code แล้วกดส่งรหัสใน LINE เพื่อผูกบัญชี"
            );
            setLinePill("ยังไม่ผูก", "is-warning");

            if (linkBtn) {
                linkBtn.disabled = false;
                linkBtn.textContent = "ผูกบัญชี LINE";
            }

            if (testBtn) {
                testBtn.hidden = true;
                testBtn.disabled = true;
            }

            if (status.line_link_code_active && status.line_link_code) {
                renderLineQr({
                    code: status.line_link_code,
                    qrPayload: status.qr_payload || status.line_open_url,
                    lineOpenUrl: status.line_open_url || status.qr_payload,
                    expiresAt: status.line_link_code_expires_at,
                });
            }

            return;
        }

        desc.textContent = enabled ? "เปิดอยู่" : "ปิดอยู่";
        setText("lineStatusText", "ผูกบัญชี LINE แล้ว");
        setText(
            "lineHelpText",
            enabled
                ? "ระบบจะส่งแจ้งเตือน LINE เมื่อเกิด alert ตามเงื่อนไข"
                : "เปิด toggle เพื่อรับแจ้งเตือนผ่าน LINE"
        );
        setLinePill(enabled ? "เปิดใช้งาน" : "ปิดอยู่", enabled ? "is-success" : "is-muted");

        if (linkBtn) {
            linkBtn.disabled = false;
            linkBtn.textContent = "ผูกบัญชีใหม่";
        }

        if (testBtn) {
            testBtn.hidden = false;
            testBtn.disabled = !enabled;
        }

        hideLineQr();
    }

    function renderLineQr({ code, qrPayload, lineOpenUrl, expiresAt }) {
        const qrArea = $("lineQrArea");
        const qrBox = $("lineQrCode");
        const codeEl = $("lineLinkCode");
        const openBtn = $("lineOpenBtn");
        const note = $("lineQrNote");

        const cleanCode = String(code || "").trim().toUpperCase();
        const cleanPayload = String(qrPayload || lineOpenUrl || "").trim();
        const cleanOpenUrl = String(lineOpenUrl || qrPayload || "").trim();

        if (!qrArea || !qrBox || !cleanCode || !cleanPayload) {
            return;
        }

        qrArea.hidden = false;

        if (codeEl) {
            codeEl.textContent = cleanCode;
        }

        qrBox.innerHTML = "";

        if (window.QRCode) {
            try {
                new QRCode(qrBox, {
                    text: cleanPayload,
                    width: 164,
                    height: 164,
                    correctLevel: QRCode.CorrectLevel.M,
                });
            } catch (err) {
                console.warn("Cannot render QRCode:", err);
                qrBox.innerHTML = '<span class="line-qr-placeholder">เปิด LINE</span>';
            }
        } else {
            qrBox.innerHTML = '<span class="line-qr-placeholder">เปิด LINE</span>';
        }

        if (openBtn) {
            if (cleanOpenUrl) {
                openBtn.href = cleanOpenUrl;
                openBtn.hidden = false;
            } else {
                openBtn.removeAttribute("href");
                openBtn.hidden = true;
            }
        }

        if (note) {
            note.textContent = expiresAt
                ? `รหัสนี้มีเวลาจำกัด หากหมดอายุให้กดผูกบัญชี LINE ใหม่`
                : "หลังจากเปิด LINE แล้ว ให้กดส่งรหัสที่ระบบเตรียมไว้ในช่องแชต";
        }

        setText("lineStatusText", "สแกน QR Code แล้วกดส่งรหัสใน LINE เพื่อผูกบัญชี");
        setText("lineHelpText", "ถ้าสแกนไม่ได้ ให้คัดลอกรหัสแล้วส่งในแชต LINE Official Account");
        setLinePill("รอผูกบัญชี", "is-warning");
    }

    function hideLineQr() {
        const qrArea = $("lineQrArea");
        const qrBox = $("lineQrCode");
        const openBtn = $("lineOpenBtn");

        if (qrArea) {
            qrArea.hidden = true;
        }

        if (qrBox) {
            qrBox.innerHTML = '<span class="line-qr-placeholder">QR</span>';
        }

        if (openBtn) {
            openBtn.hidden = true;
            openBtn.removeAttribute("href");
        }

        setText("lineLinkCode", "PG-------");
    }

    function renderLineErrorState(message) {
        setLinePill("มีปัญหา", "is-error");
        setLineError(message);
    }

    function hideLineError() {
        setLineError("");
    }

    function setLineError(message) {
        const errorEl = $("lineErrorText");
        const text = String(message || "").trim();

        if (!errorEl) {
            return;
        }

        if (!text) {
            errorEl.hidden = true;
            errorEl.textContent = "";
            return;
        }

        errorEl.hidden = false;
        errorEl.textContent = text;
    }

    function setLinePill(text, className) {
        const pill = $("lineStatusPill");

        if (!pill) {
            return;
        }

        pill.textContent = text;
        pill.classList.remove(
            "is-waiting",
            "is-warning",
            "is-success",
            "is-error",
            "is-muted"
        );

        if (className) {
            pill.classList.add(className);
        }
    }

    async function fetchLineStatusSafe() {
        try {
            return await fetchLineStatus();
        } catch (_) {
            return null;
        }
    }

    function normalizeLineStatusResponse(data) {
        if (!data) {
            return null;
        }

        return data.line || data.status || data;
    }

    async function fetchLineStatus() {
        const userId = getCurrentUserId();
        const query = userId ? `?user_id=${encodeURIComponent(userId)}` : "";

        const response = await fetch(`${utils.API_BASE}/notification/line/status${query}`, {
            method: "GET",
            headers: {
                "Content-Type": "application/json",
            },
        });

        const contentType = response.headers.get("content-type") || "";
        const data = contentType.includes("application/json")
            ? await response.json()
            : null;

        if (!response.ok) {
            throw new Error(data?.detail || `LINE status error ${response.status}`);
        }

        if (data && data.success === false) {
            throw new Error(data.detail || data.message || "LINE status failed");
        }

        const status = normalizeLineStatusResponse(data);

        if (!status) {
            throw new Error("LINE status response is empty");
        }

        return status;
    }

    async function createLineLinkCode() {
        const userId = getCurrentUserId();

        if (!userId) {
            throw new Error("ไม่พบข้อมูลผู้ใช้ที่เข้าสู่ระบบ");
        }

        const response = await fetch(`${utils.API_BASE}/notification/line/link-code`, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
            },
            body: JSON.stringify({ user_id: userId }),
        });

        const contentType = response.headers.get("content-type") || "";
        const data = contentType.includes("application/json")
            ? await response.json()
            : null;

        if (!response.ok) {
            throw new Error(data?.detail || `LINE link code error ${response.status}`);
        }

        if (data && data.success === false) {
            throw new Error(data.detail || data.message || "LINE link code failed");
        }

        return data;
    }

    async function setLineEnabled(enabled) {
        const userId = getCurrentUserId();
        const body = userId
            ? { user_id: userId, enabled }
            : { enabled };

        const response = await fetch(`${utils.API_BASE}/notification/line/enabled`, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
            },
            body: JSON.stringify(body),
        });

        const contentType = response.headers.get("content-type") || "";
        const data = contentType.includes("application/json")
            ? await response.json()
            : null;

        if (!response.ok) {
            throw new Error(data?.detail || `LINE update error ${response.status}`);
        }

        if (data && data.success === false) {
            throw new Error(data.detail || data.message || "LINE update failed");
        }

        const status = normalizeLineStatusResponse(data);

        if (!status) {
            throw new Error("LINE enabled response is empty");
        }

        return status;
    }

    async function testLineNotification() {
        const userId = getCurrentUserId();

        if (!userId) {
            throw new Error("ไม่พบข้อมูลผู้ใช้ที่เข้าสู่ระบบ");
        }

        const response = await fetch(`${utils.API_BASE}/notification/test-line`, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
            },
            body: JSON.stringify({ user_id: userId }),
        });

        const contentType = response.headers.get("content-type") || "";
        const data = contentType.includes("application/json")
            ? await response.json()
            : null;

        if (!response.ok) {
            throw new Error(data?.detail || `LINE test error ${response.status}`);
        }

        return data;
    }

    async function copyText(text) {
        const value = String(text || "").trim();

        if (!value) {
            return false;
        }

        if (navigator.clipboard && window.isSecureContext) {
            try {
                await navigator.clipboard.writeText(value);
                return true;
            } catch (err) {
                console.warn("Clipboard API failed:", err);
            }
        }

        try {
            const textarea = document.createElement("textarea");
            textarea.value = value;
            textarea.setAttribute("readonly", "");
            textarea.style.position = "fixed";
            textarea.style.left = "-9999px";
            document.body.appendChild(textarea);
            textarea.select();

            const success = document.execCommand("copy");
            document.body.removeChild(textarea);

            return success;
        } catch (err) {
            console.warn("Fallback copy failed:", err);
            return false;
        }
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
            cameraStatus.classList.remove("is-active", "is-live", "is-ready");
        }

        const statusCard = $("statusCard");

        if (statusCard) {
            statusCard.className = "status-card is-waiting";
        }

        setText("statusBadge", "รอการเชื่อมต่อ");
        setText("statusMessage", "เชื่อมต่อ backend ไม่ได้");
        setText("currentAdvice", "ตรวจสอบว่า backend เปิดอยู่ แล้วรีเฟรชหน้านี้อีกครั้ง");

        updateIssueStatus("cva", "waiting");
        updateIssueStatus("fsa", "waiting");
    }

    function renderPosture(posture) {
        const status = posture.status || "no_person_detected";
        const hasForwardHead = posture.is_forward_head === true;
        const hasRoundedShoulder = posture.is_rounded_shoulder === true;
        const hasActiveAlert =
            posture.forward_head_alert_active === true ||
            posture.rounded_shoulder_alert_active === true;

        currentRiskInFrame =
            status === "bad" ||
            hasForwardHead ||
            hasRoundedShoulder ||
            hasActiveAlert;

        const statusMap = {
            good: {
                label: "ปกติ",
                className: "is-good",
                message: "CVA และ FSA อยู่ในเกณฑ์ดี",
                advice: "นั่งได้ดีแล้ว รักษาระดับศีรษะ คอ และหัวไหล่ให้อยู่ในแนวเดิม",
            },
            bad: {
                label: hasActiveAlert ? "ควรปรับท่าทาง" : "เริ่มเสี่ยง",
                className: hasActiveAlert ? "is-danger" : "is-warning",
                message: buildBadPostureMessage(hasForwardHead, hasRoundedShoulder),
                advice: "ลองปรับศีรษะและหัวไหล่ให้อยู่ในแนวที่สบายขึ้น",
            },
            paused: {
                label: "หยุดชั่วคราว",
                className: "is-waiting",
                message: "ระบบยังไม่จับเวลาขณะนี้",
                advice: "จัดตำแหน่งให้อยู่ในกรอบกล้องด้านข้าง",
            },
            no_person_detected: {
                label: "ไม่พบผู้ใช้งาน",
                className: "is-waiting",
                message: "ยังไม่พบผู้ใช้ในกรอบกล้อง",
                advice: "กรุณานั่งให้อยู่ในกรอบกล้องและให้เห็นด้านข้างชัดเจน",
            },
            marker_not_detected: {
                label: "อ่านท่าทางไม่ชัด",
                className: "is-waiting",
                message: "ระบบยังอ่านตำแหน่งคอและไหล่ได้ไม่ครบ",
                advice: "ปรับแสงหรือขยับกล้องให้เห็นศีรษะ คอ และหัวไหล่ชัดขึ้น",
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

    function buildBadPostureMessage(hasForwardHead, hasRoundedShoulder) {
        if (hasForwardHead && hasRoundedShoulder) {
            return "พบแนวโน้มคอยื่นและไหล่ห่อ";
        }

        if (hasForwardHead) {
            return "พบแนวโน้มคอยื่น";
        }

        if (hasRoundedShoulder) {
            return "พบแนวโน้มไหล่ห่อ";
        }

        return "พบแนวโน้มท่าทางเสี่ยง";
    }

    function renderIssueValues(posture) {
        const cva = normalizeNumber(posture.cva_angle);
        const fsa = normalizeNumber(posture.fsa_angle);

        setText("cvaValue", formatMetric(posture.cva_angle));
        setText("fsaValue", formatMetric(posture.fsa_angle));

        setText("cvaHint", getCvaHint(posture));
        setText("fsaHint", getFsaHint(posture));

        updateIssueStatus("cva", getAngleStatus({
            value: cva,
            threshold: CVA_NORMAL_THRESHOLD,
            isAlertActive: posture.forward_head_alert_active === true,
            isIssueActive: posture.is_forward_head === true,
        }));

        updateIssueStatus("fsa", getAngleStatus({
            value: fsa,
            threshold: FSA_NORMAL_THRESHOLD,
            isAlertActive: posture.rounded_shoulder_alert_active === true,
            isIssueActive: posture.is_rounded_shoulder === true,
        }));

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
        const alertCount = Number(summary.alert_count || 0);

        const goodPct = percent(good, effective);
        const riskPct = Math.max(0, 100 - goodPct);

        setText("goodPostureRatio", `${goodPct.toFixed(0)}%`);
        setText("riskPostureRatio", `${riskPct.toFixed(0)}%`);
        setText("forwardHeadDuration", formatTime(forward));
        setText("roundedShoulderDuration", formatTime(rounded));
        setText("alertCount", `${alertCount} ครั้ง`);

        setText("goodTime", formatTime(good));
        setStatsNote(buildStatsNote(riskPct));
    }

    function buildStatsNote(riskPct) {
        if (currentRiskInFrame && riskPct < 1) {
            return "พบความเสี่ยงแล้ว หากค้างต่อเนื่องระบบจะเริ่มนับสะสม";
        }

        if (currentRiskInFrame) {
            return "กำลังนับช่วงท่าทางเสี่ยง";
        }

        return "";
    }

    function setStatsNote(message) {
        const note = $("statsNote");

        if (!note) {
            return;
        }

        const text = String(message || "").trim();

        if (!text) {
            note.hidden = true;
            note.textContent = "";
            return;
        }

        note.hidden = false;
        note.textContent = text;
    }

    function buildCurrentAdvice(posture, fallback) {
        const cva = normalizeNumber(posture.cva_angle);
        const fsa = normalizeNumber(posture.fsa_angle);

        const hasForwardHead =
            posture.is_forward_head === true ||
            (Number.isFinite(cva) && cva < CVA_NORMAL_THRESHOLD);

        const hasRoundedShoulder =
            posture.is_rounded_shoulder === true ||
            (Number.isFinite(fsa) && fsa < FSA_NORMAL_THRESHOLD);

        if (hasForwardHead && hasRoundedShoulder) {
            return "ดึงคางกลับเล็กน้อย เปิดอก และผ่อนหัวไหล่ลง";
        }

        if (hasForwardHead) {
            return "ดึงคางกลับเล็กน้อย ให้หูอยู่ใกล้แนวหัวไหล่มากขึ้น";
        }

        if (hasRoundedShoulder) {
            return "ผ่อนหัวไหล่ลง เปิดอกเล็กน้อย และวางแขนให้สบาย";
        }

        return fallback || "รักษาระดับศีรษะ คอ และหัวไหล่ให้อยู่ในแนวเดิม";
    }

    function getAngleStatus({ value, threshold, isAlertActive, isIssueActive }) {
        if (!Number.isFinite(value)) {
            return "waiting";
        }

        if (value >= threshold) {
            return "good";
        }

        if (isAlertActive) {
            return "danger";
        }

        if (isIssueActive) {
            return "warning";
        }

        return "warning";
    }

    function updateIssueStatus(type, status) {
        const configMap = {
            good: {
                label: "ปกติ",
                cardClass: "is-good",
                pillClass: "is-good",
            },
            warning: {
                label: "เริ่มเสี่ยง",
                cardClass: "is-warning",
                pillClass: "is-warning",
            },
            danger: {
                label: "ควรปรับ",
                cardClass: "is-danger",
                pillClass: "is-danger",
            },
            waiting: {
                label: "รอข้อมูล",
                cardClass: "",
                pillClass: "",
            },
        };

        const item = configMap[status] || configMap.waiting;
        const card = type === "cva" ? $("cvaMetricCard") : $("fsaMetricCard");
        const pill = type === "cva" ? $("cvaStatusPill") : $("fsaStatusPill");

        if (card) {
            card.classList.remove(
                "is-good",
                "is-normal",
                "is-warning",
                "is-danger",
                "good",
                "normal",
                "warning",
                "danger"
            );

            if (item.cardClass) {
                card.classList.add(item.cardClass);
            }
        }

        if (pill) {
            pill.textContent = item.label;
            pill.classList.remove(
                "is-good",
                "is-normal",
                "is-warning",
                "is-danger",
                "good",
                "normal",
                "warning",
                "danger"
            );

            if (item.pillClass) {
                pill.classList.add(item.pillClass);
            }
        }
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
            posture.alert === true ||
            forwardHeadAlert ||
            roundedShoulderAlert;

        const becameForwardHeadActive =
            forwardHeadAlertActive && !lastForwardHeadAlertActive;

        const becameRoundedShoulderActive =
            roundedShoulderAlertActive && !lastRoundedShoulderAlertActive;

        lastForwardHeadAlertActive = forwardHeadAlertActive;
        lastRoundedShoulderAlertActive = roundedShoulderAlertActive;

        const shouldNotify =
            directAlert ||
            becameForwardHeadActive ||
            becameRoundedShoulderActive;

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

    function shouldShowBrowserNotification() {
        return document.hidden || !document.hasFocus();
    }

    function showBrowserNotification(message) {
        if (!notificationEnabled) {
            return;
        }

        if (!shouldShowBrowserNotification()) {
            return;
        }

        if (!("Notification" in window)) {
            return;
        }

        if (Notification.permission !== "granted") {
            return;
        }

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
        setText("statusMessage", "ระบบกำลังหยุด session และบันทึกผล");
        setText("currentAdvice", "ระบบกำลังบันทึกและสรุปผลการใช้งาน");

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
        }, 1800);
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