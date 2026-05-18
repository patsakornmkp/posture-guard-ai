/* =========================================================
   PostureGuard Alert Speech
   File: frontend/alert-speech.js
   ใช้เสียงพูดแจ้งเตือนเฉพาะตอน Active Session ทำงานอยู่
========================================================= */

(function () {
    "use strict";

    // guard: ป้องกัน script โหลดซ้ำ
    if (window.__postureGuardSpeechLoaded) return;
    window.__postureGuardSpeechLoaded = true;

    let speechEnabled = false;
    let lastSpeechTime = 0;
    let watcherId = null;
    let cachedVoices = [];

    const SPEECH_COOLDOWN = 8000;
    const ALERT_MESSAGE = "กรุณาปรับท่านั่ง";
    const ENABLE_MESSAGE = "เปิดเสียงแจ้งเตือนแล้ว";

    // ---------- Helpers ----------

    function ready(callback) {
        if (document.readyState === "loading") {
            document.addEventListener("DOMContentLoaded", callback);
        } else {
            callback();
        }
    }

    function isSessionActive() {
        const activeSession = document.getElementById("activeSession");
        return activeSession ? activeSession.hidden === false : false;
    }

    // ---------- Voice cache (Bug 4) ----------
    // Chrome โหลด voices แบบ async — cache ไว้ล่วงหน้าเพื่อให้พร้อมใช้ทันที
    function loadVoices() {
        const voices = window.speechSynthesis.getVoices();
        if (voices.length > 0) cachedVoices = voices;
    }

    if ("speechSynthesis" in window) {
        window.speechSynthesis.onvoiceschanged = function () {
            loadVoices();
        };
        loadVoices(); // ลองโหลดทันที (Firefox พร้อมเลย)
    }

    // ---------- Speak ----------

    function speak(message, force = false) {
        if (!("speechSynthesis" in window)) return;

        if (!force && !isSessionActive()) return;
        if (!speechEnabled && !force) return;

        const now = Date.now();
        if (!force && now - lastSpeechTime < SPEECH_COOLDOWN) return;

        lastSpeechTime = now;
        window.speechSynthesis.cancel();

        const utterance = new SpeechSynthesisUtterance(message);
        utterance.lang = "th-TH";
        utterance.rate = 1.0;
        utterance.pitch = 1.0;
        utterance.volume = 1.0;

        // Bug 4 fix: ใช้ cachedVoices แทน getVoices() ตอนพูดจริง
        const thaiVoice = cachedVoices.find(function (v) {
            return v.lang && v.lang.toLowerCase().startsWith("th");
        });
        if (thaiVoice) utterance.voice = thaiVoice;

        window.speechSynthesis.speak(utterance);
    }

    // ---------- Enable / Disable ----------

    function stopSpeech() {
        if ("speechSynthesis" in window) window.speechSynthesis.cancel();
        lastSpeechTime = 0;
    }

    function disableSpeech() {
        speechEnabled = false;
        stopSpeech();

        const button = document.getElementById("speechToggleBtn");
        if (button) {
            button.dataset.enabled = "false";
            button.textContent = "🔇 เปิดเสียงแจ้งเตือน";
        }
    }

    // ---------- Button setup (Bug 5 fix: ใช้ { once: false } + guard dataset) ----------

    function setupSpeechToggleButton() {
        const button = document.getElementById("speechToggleBtn");
        if (!button) return;

        // set initial state
        button.dataset.enabled = "false";
        button.textContent = "🔇 เปิดเสียงแจ้งเตือน";

        // Bug 5 fix: ลบ listener เก่าออกก่อน (ป้องกัน listener ซ้อน)
        button.removeEventListener("click", onSpeechToggleClick);
        button.addEventListener("click", onSpeechToggleClick);
    }

    function onSpeechToggleClick() {
        const button = document.getElementById("speechToggleBtn");
        if (!button) return;

        const isEnabled = button.dataset.enabled === "true";
        if (isEnabled) {
            disableSpeech();
        } else {
            speechEnabled = true;
            button.dataset.enabled = "true";
            button.textContent = "🔊 ปิดเสียงแจ้งเตือน";
            speak(ENABLE_MESSAGE, true);
        }
    }

    // ---------- Bad status detection (Bug 3 fix: ใช้ CSS class แทน text) ----------

    function isBadStatus() {
        if (!isSessionActive()) return false;

        const statusCard = document.getElementById("statusCard");
        if (statusCard) {
            if (
                statusCard.classList.contains("status-bad") ||
                statusCard.classList.contains("status-warn")
            ) {
                return true;
            }
        }

        // fallback: alertToast ที่กำลังแสดงอยู่
        const alertToast = document.getElementById("alertToast");
        if (alertToast && alertToast.hidden === false) return true;

        return false;
    }

    // ---------- Watcher (Bug 2 fix: expose start/stop) ----------

    function startAlertWatcher() {
        stopAlertWatcher(); // ล้าง watcher เก่าก่อนเสมอ
        watcherId = setInterval(function () {
            if (isBadStatus()) speak(ALERT_MESSAGE);
        }, 1000);
    }

    function stopAlertWatcher() {
        if (watcherId !== null) {
            clearInterval(watcherId);
            watcherId = null;
        }
    }

    // ---------- Stop session handlers ----------

    function setupStopSessionHandler() {
        const stopBtn = document.getElementById("stopBtn");
        const backBtn = document.getElementById("backBtn");

        if (stopBtn) {
            stopBtn.removeEventListener("click", onSessionStop);
            stopBtn.addEventListener("click", onSessionStop);
        }
        if (backBtn) {
            backBtn.removeEventListener("click", onSessionStop);
            backBtn.addEventListener("click", onSessionStop);
        }
    }

    function onSessionStop() {
        disableSpeech();
        // Bug 2 fix: หยุด watcher ด้วยเมื่อ session จบ
        stopAlertWatcher();
    }

    // ---------- Init ----------

    ready(function () {
        setupSpeechToggleButton();
        setupStopSessionHandler();
        startAlertWatcher();
    });

    // expose สำหรับ dashboard.js ถ้าต้องการ restart watcher หลัง start session ใหม่
    window.alertSpeech = {
        startWatcher: startAlertWatcher,
        stopWatcher: stopAlertWatcher,
        disable: disableSpeech,
    };
})();