/* =========================================
   Setup Page
   File: frontend/js/setup.js

   หน้านี้ใช้เริ่ม realtime monitoring session
   - ไม่มี Calibration / Baseline
   - ไม่เลือกเวลาล่วงหน้า
   - session จะทำงานจนกว่าผู้ใช้กดหยุดเอง
========================================= */

document.addEventListener("DOMContentLoaded", async () => {
    "use strict";

    if (!window.api || !window.utils) {
        alert("ระบบ frontend โหลดไม่ครบ กรุณาตรวจสอบว่า app.js ถูกโหลดก่อน setup.js");
        window.location.replace("login.html");
        return;
    }

    const canOpenSetup = await utils.requireNoActiveMonitoring();

    if (!canOpenSetup) {
        return;
    }

    const user = utils.getCurrentUser();

    if (!user) {
        utils.redirectTo("login.html", { replace: true });
        return;
    }

    setupUserInfo(user);
    setupStartButton(user);
});

function setupUserInfo(user) {
    const userName = document.getElementById("userName");
    const userLabel = user?.full_name || user?.username || "ผู้ใช้งาน";

    if (userName) {
        userName.textContent = userLabel;
    }
}

function setupStartButton(user) {
    const startBtn = document.getElementById("startBtn");
    const setupStatus = document.getElementById("setupStatus");

    if (!startBtn) {
        return;
    }

    startBtn.disabled = false;

    startBtn.addEventListener("click", async () => {
        startBtn.disabled = true;
        startBtn.textContent = "กำลังเริ่มระบบ...";

        setStatus(setupStatus, "กำลังเปิดกล้องและเริ่ม session", "loading");

        try {
            await api.startCamera();

            const session = await api.startSession(user.id, 0);
            const sessionId = session?.session_id || session?.id || null;

            utils.markMonitoringSessionStarted(sessionId);

            setStatus(setupStatus, "เริ่มระบบสำเร็จ กำลังไปหน้า Monitoring", "success");

            window.location.replace("monitoring.html");
        } catch (err) {
            console.error("Start monitoring failed:", err);

            try {
                await api.stopCamera();
            } catch (stopErr) {
                console.warn("Cannot stop camera after start failure:", stopErr);
            }

            utils.clearSessionFlowState({ keepLast: true });

            setStatus(
                setupStatus,
                "เริ่มระบบไม่สำเร็จ: " + err.message,
                "error"
            );

            startBtn.disabled = false;
            startBtn.textContent = "▶ เริ่มใช้งาน";
        }
    });
}

function setStatus(element, message, type = "info") {
    if (!element) {
        return;
    }

    element.hidden = false;
    element.textContent = message;
    element.classList.remove("is-info", "is-loading", "is-success", "is-error");
    element.classList.add(`is-${type}`);
}