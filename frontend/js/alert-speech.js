/* =========================================================
   PostureGuard Alert Speech
   File: frontend/js/alert-speech.js

   หน้าที่:
   - เปิด/ปิดเสียงแจ้งเตือน
   - อ่านข้อความ alert ที่ monitoring.js ส่งเข้ามา
   - ไม่ได้ตัดสิน CVA / FSA เอง
   - ไม่ได้ควบคุมเวลานั่งผิด 3 นาที
========================================================= */

(function () {
    "use strict";

    if (window.__postureGuardSpeechLoaded) return;
    window.__postureGuardSpeechLoaded = true;

    let speechEnabled = false;
    let lastSpeechTime = 0;
    let cachedVoices = [];

    // cooldown ของเสียงหลังจากพูดแล้ว
    // หน่วยเป็น milliseconds
    // 8000 = 8 วินาที
    // ไม่ใช่เวลานั่งผิดก่อนแจ้งเตือน
    const SPEECH_COOLDOWN = 8000;

    const ENABLE_MESSAGE = "เปิดเสียงแจ้งเตือนแล้ว";

    function ready(callback) {
        if (document.readyState === "loading") {
            document.addEventListener("DOMContentLoaded", callback);
        } else {
            callback();
        }
    }

    function loadVoices() {
        if (!("speechSynthesis" in window)) return;

        const voices = window.speechSynthesis.getVoices();

        if (voices.length > 0) {
            cachedVoices = voices;
        }
    }

    if ("speechSynthesis" in window) {
        window.speechSynthesis.onvoiceschanged = loadVoices;
        loadVoices();
    }

    function speak(message, force = false) {
        if (!("speechSynthesis" in window)) return;
        if (!speechEnabled && !force) return;

        const now = Date.now();

        if (!force && now - lastSpeechTime < SPEECH_COOLDOWN) {
            return;
        }

        lastSpeechTime = now;

        window.speechSynthesis.cancel();
        window.speechSynthesis.resume();

        const utterance = new SpeechSynthesisUtterance(
            message || "กรุณาปรับท่านั่งให้อยู่ในท่าที่เหมาะสม"
        );

        utterance.lang = "th-TH";
        utterance.rate = 1.0;
        utterance.pitch = 1.0;
        utterance.volume = 1.0;

        const thaiVoice = cachedVoices.find((voice) =>
            voice.lang && voice.lang.toLowerCase().startsWith("th")
        );

        if (thaiVoice) {
            utterance.voice = thaiVoice;
        }

        window.speechSynthesis.speak(utterance);
    }

    function speakAlert(message) {
        if (!speechEnabled) return;

        speak(
            message || "กรุณาปรับท่านั่งให้อยู่ในท่าที่เหมาะสม",
            false
        );
    }

    function stopSpeech() {
        if ("speechSynthesis" in window) {
            window.speechSynthesis.cancel();
        }

        lastSpeechTime = 0;
    }

    function updateToggleUI(enabled, text = null) {
        const desc = document.getElementById("soundDesc");

        if (desc) {
            desc.textContent = text || (enabled ? "เปิดอยู่" : "ปิดอยู่");
        }
    }

    function enableSpeech(announce = false) {
        if (!("speechSynthesis" in window)) {
            updateToggleUI(false, "ไม่รองรับ");
            return false;
        }

        speechEnabled = true;

        const toggle = document.getElementById("speechToggleBtn");

        if (toggle) {
            toggle.checked = true;
            toggle.disabled = false;
        }

        updateToggleUI(true);

        if (announce) {
            speak(ENABLE_MESSAGE, true);
        }

        return true;
    }

    function disableSpeech() {
        speechEnabled = false;
        stopSpeech();

        const toggle = document.getElementById("speechToggleBtn");

        if (toggle) {
            toggle.checked = false;
        }

        updateToggleUI(false);
    }

    function setupSpeechToggleButton() {
        const toggle = document.getElementById("speechToggleBtn");
        if (!toggle) return;

        if (!("speechSynthesis" in window)) {
            toggle.checked = false;
            toggle.disabled = true;
            updateToggleUI(false, "ไม่รองรับ");
            return;
        }

        speechEnabled = false;
        toggle.checked = false;
        updateToggleUI(false);

        toggle.addEventListener("change", () => {
            if (toggle.checked) {
                enableSpeech(true);
            } else {
                disableSpeech();
            }
        });
    }

    function setupStopSessionHandler() {
        const stopBtn = document.getElementById("stopBtn");
        const backBtn = document.getElementById("backBtn");

        if (stopBtn) {
            stopBtn.addEventListener("click", disableSpeech);
        }

        if (backBtn) {
            backBtn.addEventListener("click", disableSpeech);
        }

        window.addEventListener("pagehide", disableSpeech);
    }

    ready(() => {
        setupSpeechToggleButton();
        setupStopSessionHandler();
    });

    window.alertSpeech = {
        speak: speakAlert,
        enable() {
            return enableSpeech(false);
        },
        disable: disableSpeech,
        test() {
            enableSpeech(false);
            speak("ทดสอบเสียงแจ้งเตือน", true);
        },
    };
})();