/* =========================================================
   PostureGuard Alert Speech
   File: frontend/js/alert-speech.js

   หน้าที่:
   - เปิด/ปิดเสียงแจ้งเตือน
   - อ่านข้อความ alert ที่ monitoring.js ส่งเข้ามา
   - ไม่ตัดสิน CVA / FSA เอง
   - ไม่ควบคุมเวลานั่งผิด 10 วินาที / 3 นาที
   - ไม่ผูก event กับปุ่มซ้ำ เพราะ monitoring.js เป็นคนคุม toggle
========================================================= */

(function () {
    "use strict";

    if (window.__postureGuardSpeechLoaded) {
        return;
    }

    window.__postureGuardSpeechLoaded = true;

    let speechEnabled = false;
    let lastSpeechTime = 0;
    let cachedVoices = [];
    let speaking = false;

    const DEFAULT_ALERT_MESSAGE = "กรุณาปรับท่านั่งให้อยู่ในท่าที่เหมาะสม";
    const ENABLE_MESSAGE = "เปิดเสียงแจ้งเตือนแล้ว";

    /*
       สำคัญ:
       backend เป็นตัวคุมรอบแจ้งเตือนจริง เช่น 10 วินาทีตอนทดสอบ
       หรือ 180 วินาทีตอนใช้งานจริง

       cooldown ตรงนี้มีไว้กันเสียงซ้ำจาก polling เท่านั้น
       ห้ามตั้งยาวเกินไป ไม่งั้นจะเกิดอาการ:
       backend นับ alert แล้ว แต่เสียงไม่ขึ้น
    */
    const SPEECH_COOLDOWN = 2500;

    function ready(callback) {
        if (document.readyState === "loading") {
            document.addEventListener("DOMContentLoaded", callback);
            return;
        }

        callback();
    }

    function isSupported() {
        return "speechSynthesis" in window && "SpeechSynthesisUtterance" in window;
    }

    function loadVoices() {
        if (!isSupported()) {
            return;
        }

        const voices = window.speechSynthesis.getVoices();

        if (Array.isArray(voices) && voices.length > 0) {
            cachedVoices = voices;
        }
    }

    function pickThaiVoice() {
        if (!cachedVoices.length) {
            loadVoices();
        }

        const thaiVoice = cachedVoices.find((voice) => {
            const lang = String(voice.lang || "").toLowerCase();
            return lang.startsWith("th");
        });

        if (thaiVoice) {
            return thaiVoice;
        }

        return cachedVoices.find((voice) => {
            const name = String(voice.name || "").toLowerCase();
            const lang = String(voice.lang || "").toLowerCase();

            return (
                name.includes("thai") ||
                name.includes("thailand") ||
                lang.includes("th")
            );
        }) || null;
    }

    function normalizeMessage(message) {
        const text = String(message || "").trim();
        return text || DEFAULT_ALERT_MESSAGE;
    }

    function safeCancel() {
        if (!isSupported()) {
            return;
        }

        try {
            window.speechSynthesis.cancel();
        } catch (err) {
            console.warn("Cannot cancel speech synthesis:", err);
        }
    }

    function safeResume() {
        if (!isSupported()) {
            return;
        }

        try {
            window.speechSynthesis.resume();
        } catch (err) {
            console.warn("Cannot resume speech synthesis:", err);
        }
    }

    function createUtterance(message) {
        const utterance = new SpeechSynthesisUtterance(normalizeMessage(message));

        utterance.lang = "th-TH";
        utterance.rate = 1.0;
        utterance.pitch = 1.0;
        utterance.volume = 1.0;

        const thaiVoice = pickThaiVoice();

        if (thaiVoice) {
            utterance.voice = thaiVoice;
        }

        utterance.onstart = () => {
            speaking = true;
        };

        utterance.onend = () => {
            speaking = false;
        };

        utterance.onerror = (event) => {
            speaking = false;
            console.warn("Speech synthesis error:", event);
        };

        return utterance;
    }

    function speakInternal(message, options = {}) {
        const force = options.force === true;
        const markTime = options.markTime !== false;

        if (!isSupported()) {
            updateToggleUI(false, "ไม่รองรับ");
            return false;
        }

        if (!speechEnabled && !force) {
            return false;
        }

        const now = Date.now();

        if (!force && now - lastSpeechTime < SPEECH_COOLDOWN) {
            return false;
        }

        if (markTime) {
            lastSpeechTime = now;
        }

        const utterance = createUtterance(message);

        try {
            /*
               cancel ก่อนพูด เพื่อแก้ปัญหา speechSynthesis ค้างคิว
               resume ซ้ำอีกทีหลัง speak เพื่อช่วย Chrome/Chromium บางเครื่อง
            */
            safeCancel();
            safeResume();

            window.speechSynthesis.speak(utterance);

            window.setTimeout(() => {
                safeResume();
            }, 80);

            window.setTimeout(() => {
                safeResume();
            }, 300);

            return true;
        } catch (err) {
            speaking = false;
            console.warn("Cannot speak alert message:", err);
            return false;
        }
    }

    function speakAlert(message) {
        return speakInternal(message || DEFAULT_ALERT_MESSAGE, {
            force: false,
            markTime: true,
        });
    }

    function stopSpeech() {
        safeCancel();
        speaking = false;
        lastSpeechTime = 0;
    }

    function updateToggleUI(enabled, text = null) {
        const toggle = document.getElementById("speechToggleBtn");
        const desc = document.getElementById("soundDesc");

        if (toggle) {
            toggle.checked = enabled;
            toggle.disabled = !isSupported();
        }

        if (desc) {
            desc.textContent = text || (enabled ? "เปิดอยู่" : "ปิดอยู่");
        }
    }

    function enableSpeech(announce = true) {
        if (!isSupported()) {
            speechEnabled = false;
            updateToggleUI(false, "ไม่รองรับ");
            return false;
        }

        loadVoices();

        speechEnabled = true;
        updateToggleUI(true, "เปิดอยู่");

        /*
           ให้มีเสียงตอบรับตอนกดเปิด
           เพื่อช่วย unlock speech engine จาก user gesture
           ลดอาการ alert จริงมาถึงแล้ว browser ไม่ยอมเล่นเสียง
        */
        if (announce) {
            speakInternal(ENABLE_MESSAGE, {
                force: true,
                markTime: false,
            });
        } else {
            safeResume();
        }

        return true;
    }

    function disableSpeech() {
        speechEnabled = false;
        stopSpeech();
        updateToggleUI(false, "ปิดอยู่");
    }

    function testSpeech() {
        const enabled = enableSpeech(false);

        if (!enabled) {
            return false;
        }

        return speakInternal("ทดสอบเสียงแจ้งเตือน", {
            force: true,
            markTime: false,
        });
    }

    function syncInitialUI() {
        if (!isSupported()) {
            updateToggleUI(false, "ไม่รองรับ");
            return;
        }

        updateToggleUI(speechEnabled);
    }

    function setupPageHideHandler() {
        window.addEventListener("pagehide", () => {
            stopSpeech();
        });

        window.addEventListener("beforeunload", () => {
            stopSpeech();
        });
    }

    if (isSupported()) {
        window.speechSynthesis.onvoiceschanged = loadVoices;
        loadVoices();
    }

    ready(() => {
        syncInitialUI();
        setupPageHideHandler();
    });

    window.alertSpeech = {
        speak: speakAlert,

        enable() {
            return enableSpeech(true);
        },

        enableSilent() {
            return enableSpeech(false);
        },

        disable: disableSpeech,

        stop: stopSpeech,

        test: testSpeech,

        isEnabled() {
            return speechEnabled;
        },

        isSupported,
    };
})();