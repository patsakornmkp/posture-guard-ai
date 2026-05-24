/* =========================================
   History Page
   File: frontend/js/history.js

   PostureGuard AI
   - ใช้ endpoint GET /history/sessions/{user_id}
   - ใช้ localStorage currentUser จาก app.js
   - Session ต่ำกว่า 5 วินาที = ไม่สมบูรณ์
   - ไม่ให้ session 0 วินาทีแสดง Good posture 100%
   - ปรับ session card ให้ compact และอ่านง่ายขึ้น
========================================= */

(function () {
    "use strict";

    let allSessions = [];
    let filteredSessions = [];

    let activeFilter = "all";
    let activeSort = "latest";

    const MIN_COMPLETE_SESSION_SECONDS = 180;

    const $ = (id) => document.getElementById(id);

    document.addEventListener("DOMContentLoaded", async () => {
        if (!window.api || !window.utils) {
            alert("ระบบ frontend โหลดไม่ครบ กรุณาตรวจสอบว่า app.js ถูกโหลดก่อน history.js");
            window.location.replace("login.html");
            return;
        }

        if (typeof utils.requireHistoryAccess === "function") {
            const canOpenHistory = await utils.requireHistoryAccess();

            if (!canOpenHistory) {
                return;
            }
        }

        setupToolbar();
        setupStartButtonGuard();

        await loadHistory();
    });

    /* =========================
       Initial Load
    ========================= */

    async function loadHistory() {
        const user = getCurrentUserSafe();
        const userId = getUserId(user);

        if (!userId) {
            utils.redirectTo("login.html", { replace: true });
            return;
        }

        showState(
            "กำลังโหลดประวัติ",
            "ระบบกำลังดึงข้อมูล session ย้อนหลังของคุณ",
            true
        );

        try {
            const response = await fetchHistorySessions(userId);
            const sessions = normalizeHistoryResponse(response);

            allSessions = sessions
                .map(normalizeSession)
                .filter(Boolean);

            filteredSessions = [...allSessions];

            renderPage();

            hideState();

            const content = $("historyContent");

            if (content) {
                content.hidden = false;
            }
        } catch (err) {
            console.error("Load history failed:", err);

            showState(
                "โหลดประวัติไม่สำเร็จ",
                "ไม่สามารถดึงข้อมูลย้อนหลังได้ กรุณาตรวจสอบว่า backend เปิดอยู่ แล้วลองใหม่อีกครั้ง",
                false
            );
        }
    }

    async function fetchHistorySessions(userId) {
        if (window.api && typeof api.getHistory === "function") {
            return await api.getHistory(userId, 100);
        }

        const baseUrl = getApiBase();
        const response = await fetch(`${baseUrl}/history/sessions/${userId}?limit=100`);

        if (!response.ok) {
            throw new Error(`History request failed: ${response.status}`);
        }

        return await response.json();
    }

    function normalizeHistoryResponse(response) {
        if (!response) {
            return [];
        }

        if (Array.isArray(response)) {
            return response;
        }

        if (Array.isArray(response.sessions)) {
            return response.sessions;
        }

        if (Array.isArray(response.data)) {
            return response.data;
        }

        if (Array.isArray(response.history)) {
            return response.history;
        }

        return [];
    }

    /* =========================
       Toolbar
    ========================= */

    function setupToolbar() {
        const filterButtons = document.querySelectorAll("[data-range-filter]");
        const sortSelect = $("sortMode");

        filterButtons.forEach((button) => {
            button.addEventListener("click", () => {
                activeFilter = button.dataset.rangeFilter || "all";

                filterButtons.forEach((btn) => {
                    btn.classList.toggle("is-active", btn === button);
                });

                renderPage();
            });
        });

        if (sortSelect) {
            activeSort = sortSelect.value || "latest";

            sortSelect.addEventListener("change", () => {
                activeSort = sortSelect.value || "latest";
                renderPage();
            });
        }
    }

    function setupStartButtonGuard() {
        const startBtn = $("startNewSessionBtn");

        if (!startBtn) {
            return;
        }

        startBtn.addEventListener("click", async (event) => {
            event.preventDefault();

            if (typeof utils.requireNoActiveMonitoring === "function") {
                const canStart = await utils.requireNoActiveMonitoring();

                if (!canStart) {
                    return;
                }
            }

            utils.redirectTo("setup.html", { replace: false });
        });
    }

    /* =========================
       Render Page
    ========================= */

    function renderPage() {
        filteredSessions = sortSessions(
            filterSessions(allSessions, activeFilter),
            activeSort
        );

        renderOverview(allSessions);
        renderInsight(allSessions);
        renderComposition(allSessions);
        renderSessionList(filteredSessions);
        renderCount(filteredSessions.length, allSessions.length);
    }

    function renderOverview(sessions) {
        const totals = calculateTotals(sessions);

        setText("histTotalSessions", totals.totalSessions);
        setText("histTotalTime", formatDuration(totals.totalEffectiveSeconds));
        setText("histAvgGood", totals.completedSessions > 0 ? `${totals.goodRatio.toFixed(0)}%` : "—");
        setText("histTotalAlerts", totals.totalAlerts);
    }

    function renderInsight(sessions) {
        const totals = calculateTotals(sessions);

        setText("histForwardTime", formatDuration(totals.forwardSeconds));
        setText("histRoundedTime", formatDuration(totals.roundedSeconds));
        setText("histForwardAlerts", `${totals.forwardAlerts} ครั้ง`);
        setText("histRoundedAlerts", `${totals.roundedAlerts} ครั้ง`);

        setText("overviewInsight", buildInsightText(totals));
    }

    function renderComposition(sessions) {
        const totals = calculateTotals(sessions);

        if (totals.completedSessions <= 0 || totals.totalEffectiveSeconds <= 0) {
            setText("overviewGoodScore", "—");
            setText("overviewGoodPct", "—");
            setText("overviewForwardPct", "—");
            setText("overviewRoundedPct", "—");

            setWidth("overviewGoodBar", 0);
            setWidth("overviewForwardBar", 0);
            setWidth("overviewRoundedBar", 0);
            return;
        }

        const total = Math.max(totals.totalEffectiveSeconds, 1);

        const goodPct = clamp((totals.goodSeconds / total) * 100, 0, 100);
        const forwardPct = clamp((totals.forwardSeconds / total) * 100, 0, 100);
        const roundedPct = clamp((totals.roundedSeconds / total) * 100, 0, 100);

        const usedPct = goodPct + forwardPct + roundedPct;

        let normalizedGood = goodPct;
        let normalizedForward = forwardPct;
        let normalizedRounded = roundedPct;

        if (usedPct > 100) {
            const scale = 100 / usedPct;

            normalizedGood *= scale;
            normalizedForward *= scale;
            normalizedRounded *= scale;
        }

        setText("overviewGoodScore", `${goodPct.toFixed(0)}%`);
        setText("overviewGoodPct", `${goodPct.toFixed(0)}%`);
        setText("overviewForwardPct", `${forwardPct.toFixed(0)}%`);
        setText("overviewRoundedPct", `${roundedPct.toFixed(0)}%`);

        setWidth("overviewGoodBar", normalizedGood);
        setWidth("overviewForwardBar", normalizedForward);
        setWidth("overviewRoundedBar", normalizedRounded);
    }

    function renderCount(filteredCount, totalCount) {
        const label = filteredCount === totalCount
            ? `${totalCount} รายการ`
            : `${filteredCount} จาก ${totalCount} รายการ`;

        setText("historyCount", label);
    }

    function renderSessionList(sessions) {
        const list = $("historyList");

        if (!list) {
            return;
        }

        list.innerHTML = "";

        if (!allSessions.length) {
            list.innerHTML = buildEmptyState(
                "ยังไม่มีประวัติการใช้งาน",
                "เริ่มตรวจท่านั่งครั้งแรกเพื่อให้ระบบบันทึกประวัติและวิเคราะห์พฤติกรรมย้อนหลังของคุณ",
                "เริ่มตรวจใหม่"
            );
            return;
        }

        if (!sessions.length) {
            list.innerHTML = buildEmptyState(
                "ไม่พบรายการตามตัวกรอง",
                "ลองเปลี่ยนช่วงเวลา หรือล้างตัวกรองเพื่อดู session ทั้งหมด",
                "ดูทั้งหมด",
                "reset-filter"
            );

            const resetBtn = $("historyEmptyAction");

            if (resetBtn) {
                resetBtn.addEventListener("click", (event) => {
                    event.preventDefault();

                    activeFilter = "all";

                    document.querySelectorAll("[data-range-filter]").forEach((btn) => {
                        btn.classList.toggle(
                            "is-active",
                            btn.dataset.rangeFilter === "all"
                        );
                    });

                    renderPage();
                });
            }

            return;
        }

        const fragment = document.createDocumentFragment();

        sessions.forEach((session) => {
            fragment.appendChild(createSessionCard(session));
        });

        list.appendChild(fragment);
    }

    function createSessionCard(session) {
        const card = document.createElement("article");
        const risk = normalizeRisk(session);

        card.className = `history-session-card ${session.isIncomplete ? "is-incomplete" : ""}`;

        const startDate = formatDateTime(session.startedAt);
        const dateOnly = formatDateOnly(session.startedAt);
        const duration = formatDuration(session.displayDurationSeconds);

        const scoreText = session.isIncomplete
            ? "—"
            : `${session.goodRatio.toFixed(0)}%`;

        const scoreLabel = session.isIncomplete
            ? "ข้อมูลไม่พอ"
            : "Good posture";

        const metaText = session.isIncomplete
            ? `ระยะเวลาสั้นเกินไป · ${dateOnly}`
            : `ระยะเวลา ${duration} · แจ้งเตือน ${session.alertCount} ครั้ง · ${dateOnly}`;

        card.innerHTML = `
            <div class="history-session-main">
                <div class="history-session-top">
                    <strong class="history-session-date">${escapeHtml(startDate)}</strong>
                    <span class="history-risk-badge ${risk.className}">
                        ${escapeHtml(risk.label)}
                    </span>
                </div>

                <div class="history-session-meta">
                    <span>${escapeHtml(metaText)}</span>
                </div>

                <div class="history-session-compact">
                    <span>
                        <small>คอยื่น</small>
                        <strong>${escapeHtml(formatDuration(session.forwardSeconds))}</strong>
                    </span>

                    <span>
                        <small>ไหล่ห่อ</small>
                        <strong>${escapeHtml(formatDuration(session.roundedSeconds))}</strong>
                    </span>

                    <span>
                        <small>แจ้งเตือน</small>
                        <strong>${session.alertCount} ครั้ง</strong>
                    </span>
                </div>
            </div>

            <aside class="history-session-side ${session.isIncomplete ? "is-empty" : ""}" aria-label="คะแนนท่านั่งดี">
                <strong class="history-good-score">${escapeHtml(scoreText)}</strong>
                <span class="history-good-label">${escapeHtml(scoreLabel)}</span>
            </aside>
        `;

        return card;
    }

    function buildEmptyState(title, message, actionText, actionMode = "start") {
        const href = actionMode === "start" ? "setup.html" : "#";

        return `
            <article class="history-empty-card">
                <div class="history-empty-icon">📊</div>
                <h3>${escapeHtml(title)}</h3>
                <p>${escapeHtml(message)}</p>
                <a href="${href}" class="history-primary-btn" id="historyEmptyAction">
                    ${escapeHtml(actionText)}
                </a>
            </article>
        `;
    }

    /* =========================
       Normalize Session
    ========================= */

    function normalizeSession(raw) {
        if (!raw || typeof raw !== "object") {
            return null;
        }

        const actualSeconds = firstNumber(raw, [
            "actual_duration_seconds",
            "actualDurationSeconds",
            "duration_seconds",
            "duration",
            "total_duration_seconds",
        ]);

        const effectiveSeconds = firstNumber(raw, [
            "effective_seated_seconds",
            "effectiveSeatedSeconds",
            "seated_seconds",
            "total_seated_seconds",
            "actual_duration_seconds",
            "duration_seconds",
        ]);

        const goodSeconds = firstNumber(raw, [
            "good_posture_seconds",
            "goodPostureSeconds",
            "good_seconds",
        ]);

        const badSeconds = firstNumber(raw, [
            "bad_posture_seconds",
            "badPostureSeconds",
            "bad_seconds",
        ]);

        const forwardSeconds = firstNumber(raw, [
            "forward_head_seconds",
            "forwardHeadSeconds",
            "forward_head_duration",
            "forward_duration_seconds",
        ]);

        const roundedSeconds = firstNumber(raw, [
            "rounded_shoulder_seconds",
            "roundedShoulderSeconds",
            "rounded_shoulder_duration",
            "rounded_duration_seconds",
        ]);

        const alertCount = firstNumber(raw, [
            "alert_count",
            "alertCount",
            "alerts",
            "total_alerts",
        ]);

        const forwardAlerts = firstNumber(raw, [
            "forward_head_alert_count",
            "forwardHeadAlertCount",
            "forward_alert_count",
        ]);

        const roundedAlerts = firstNumber(raw, [
            "rounded_shoulder_alert_count",
            "roundedShoulderAlertCount",
            "rounded_alert_count",
        ]);

        const startedAt = firstValue(raw, [
            "started_at",
            "start_time",
            "created_at",
            "date",
            "session_start",
        ]);

        const endedAt = firstValue(raw, [
            "ended_at",
            "end_time",
            "finished_at",
            "session_end",
        ]);

        const riskLevel = String(firstValue(raw, [
            "risk_level",
            "riskLevel",
            "risk",
        ]) || "").toLowerCase();

        const safeActual = Math.max(actualSeconds, 0);
        const safeEffective = Math.max(effectiveSeconds, 0);
        const displayDurationSeconds = Math.max(safeEffective, safeActual);

        const isIncomplete = displayDurationSeconds < MIN_COMPLETE_SESSION_SECONDS;

        const safeGood = Math.max(goodSeconds, 0);
        const safeBad = Math.max(badSeconds, 0);

        let goodRatio = 0;

        if (!isIncomplete && safeEffective > 0) {
            goodRatio = (safeGood / safeEffective) * 100;
        }

        const rawBadRatio = firstNumber(raw, [
            "bad_posture_ratio",
            "badPostureRatio",
            "bad_ratio",
        ], NaN);

        const badRatio = Number.isFinite(rawBadRatio)
            ? normalizeRatio(rawBadRatio)
            : !isIncomplete && safeEffective > 0
                ? clamp((safeBad / safeEffective) * 100, 0, 100)
                : 0;

        if (!isIncomplete && (!Number.isFinite(goodRatio) || goodRatio <= 0)) {
            goodRatio = clamp(100 - badRatio, 0, 100);
        }

        const safeForwardAlerts = Math.max(forwardAlerts, 0);
        const safeRoundedAlerts = Math.max(roundedAlerts, 0);
        const safeAlertCount = Math.max(alertCount, safeForwardAlerts + safeRoundedAlerts, 0);

        return {
            id: firstValue(raw, ["id", "session_id", "sessionId"]),
            startedAt: normalizeDate(startedAt),
            endedAt: normalizeDate(endedAt),
            actualSeconds: safeActual,
            effectiveSeconds: safeEffective,
            displayDurationSeconds,
            goodSeconds: isIncomplete ? 0 : safeGood,
            badSeconds: isIncomplete ? 0 : safeBad,
            forwardSeconds: Math.max(forwardSeconds, 0),
            roundedSeconds: Math.max(roundedSeconds, 0),
            alertCount: safeAlertCount,
            forwardAlerts: safeForwardAlerts,
            roundedAlerts: safeRoundedAlerts,
            goodRatio: isIncomplete ? 0 : clamp(goodRatio, 0, 100),
            badRatio: isIncomplete ? 0 : clamp(badRatio, 0, 100),
            riskLevel,
            isIncomplete,
            raw,
        };
    }

    function firstNumber(obj, keys, fallback = 0) {
        for (const key of keys) {
            if (obj[key] !== undefined && obj[key] !== null && obj[key] !== "") {
                const value = Number(obj[key]);

                if (Number.isFinite(value)) {
                    return value;
                }
            }
        }

        return fallback;
    }

    function firstValue(obj, keys) {
        for (const key of keys) {
            if (obj[key] !== undefined && obj[key] !== null && obj[key] !== "") {
                return obj[key];
            }
        }

        return null;
    }

    function normalizeRatio(value) {
        const n = Number(value);

        if (!Number.isFinite(n)) {
            return 0;
        }

        if (n <= 1) {
            return n * 100;
        }

        return n;
    }

    function normalizeDate(value) {
        if (!value) {
            return null;
        }

        if (typeof value === "number") {
            const date = new Date(value);

            if (!Number.isNaN(date.getTime())) {
                return date;
            }
        }

        const date = new Date(String(value).replace(" ", "T"));

        if (!Number.isNaN(date.getTime())) {
            return date;
        }

        return null;
    }

    /* =========================
       Filter / Sort
    ========================= */

    function filterSessions(sessions, filter) {
        const now = new Date();

        if (filter === "all") {
            return [...sessions];
        }

        if (filter === "high") {
            return sessions.filter((session) => {
                const risk = normalizeRisk(session);
                return risk.level === "high";
            });
        }

        const days = filter === "7d" ? 7 : filter === "30d" ? 30 : null;

        if (!days) {
            return [...sessions];
        }

        const start = new Date(now);
        start.setDate(start.getDate() - days);

        return sessions.filter((session) => {
            if (!session.startedAt) {
                return false;
            }

            return session.startedAt >= start && session.startedAt <= now;
        });
    }

    function sortSessions(sessions, mode) {
        const result = [...sessions];

        result.sort((a, b) => {
            if (a.isIncomplete && !b.isIncomplete) return 1;
            if (!a.isIncomplete && b.isIncomplete) return -1;

            if (mode === "worst") {
                return b.badRatio - a.badRatio;
            }

            if (mode === "alerts") {
                return b.alertCount - a.alertCount;
            }

            if (mode === "duration") {
                return b.displayDurationSeconds - a.displayDurationSeconds;
            }

            const timeA = a.startedAt ? a.startedAt.getTime() : 0;
            const timeB = b.startedAt ? b.startedAt.getTime() : 0;

            return timeB - timeA;
        });

        return result;
    }

    /* =========================
       Calculate
    ========================= */

    function calculateTotals(sessions) {
        const completed = sessions.filter((session) => !session.isIncomplete);

        const totals = {
            totalSessions: sessions.length,
            completedSessions: completed.length,
            incompleteSessions: sessions.length - completed.length,
            totalEffectiveSeconds: 0,
            totalActualSeconds: 0,
            goodSeconds: 0,
            badSeconds: 0,
            forwardSeconds: 0,
            roundedSeconds: 0,
            totalAlerts: 0,
            forwardAlerts: 0,
            roundedAlerts: 0,
            goodRatio: 0,
            badRatio: 0,
        };

        completed.forEach((session) => {
            totals.totalEffectiveSeconds += session.effectiveSeconds;
            totals.totalActualSeconds += session.actualSeconds;
            totals.goodSeconds += session.goodSeconds;
            totals.badSeconds += session.badSeconds;
            totals.forwardSeconds += session.forwardSeconds;
            totals.roundedSeconds += session.roundedSeconds;
            totals.totalAlerts += session.alertCount;
            totals.forwardAlerts += session.forwardAlerts;
            totals.roundedAlerts += session.roundedAlerts;
        });

        if (totals.totalEffectiveSeconds > 0) {
            totals.goodRatio = clamp(
                (totals.goodSeconds / totals.totalEffectiveSeconds) * 100,
                0,
                100
            );

            totals.badRatio = clamp(100 - totals.goodRatio, 0, 100);
        }

        return totals;
    }

    function buildInsightText(totals) {
        if (!totals.totalSessions) {
            return "ยังไม่มีข้อมูลประวัติ เริ่มตรวจท่านั่งครั้งแรกเพื่อให้ระบบวิเคราะห์แนวโน้มของคุณ";
        }

        if (!totals.completedSessions) {
            return "ยังไม่มี session ที่มีข้อมูลเพียงพอสำหรับวิเคราะห์แนวโน้ม ลองใช้งานให้นานกว่า 5 วินาทีเพื่อให้ระบบสรุปผลได้แม่นขึ้น";
        }

        if (totals.forwardSeconds <= 0 && totals.roundedSeconds <= 0) {
            return "โดยรวมยังไม่พบเวลาสะสมของคอยื่นหรือไหล่ห่อมากนัก รักษาท่านั่งให้สม่ำเสมอต่อไป";
        }

        if (totals.forwardSeconds > totals.roundedSeconds) {
            return `แนวโน้มหลักคือคอยื่น สะสม ${formatDuration(totals.forwardSeconds)} มากกว่าไหล่ห่อ แนะนำให้ปรับระดับจอและดึงศีรษะกลับมาอยู่แนวเดียวกับลำตัว`;
        }

        if (totals.roundedSeconds > totals.forwardSeconds) {
            return `แนวโน้มหลักคือไหล่ห่อ สะสม ${formatDuration(totals.roundedSeconds)} มากกว่าคอยื่น แนะนำให้เปิดอก ผ่อนคลายไหล่ และปรับตำแหน่งแขนบนโต๊ะ`;
        }

        return "คอยื่นและไหล่ห่อมีสัดส่วนใกล้เคียงกัน แนะนำให้จัดทั้งระดับจอ ระยะห่างเก้าอี้ และตำแหน่งไหล่ให้สมดุล";
    }

    function normalizeRisk(session) {
        if (session.isIncomplete) {
            return {
                level: "incomplete",
                label: "ไม่สมบูรณ์",
                className: "is-incomplete",
            };
        }

        const alertCount = Number(session.alertCount) || 0;
        const badRatio = Number(session.badRatio) || 0;
        const forwardSeconds = Number(session.forwardSeconds) || 0;
        const roundedSeconds = Number(session.roundedSeconds) || 0;
        const badSeconds = forwardSeconds + roundedSeconds;

        /*
          ใช้ข้อมูลจริงใน session เป็นหลัก
          ไม่เชื่อ risk_level จาก backend ก่อน
          เพราะบาง session อาจมี alert แต่ backend ยังส่ง low มา
        */

        if (alertCount >= 3 || badRatio >= 40 || badSeconds >= 600) {
            return {
                level: "high",
                label: "เสี่ยงสูง",
                className: "is-high",
            };
        }

        if (alertCount >= 1 || badRatio >= 15 || badSeconds >= 120) {
            return {
                level: "medium",
                label: "เสี่ยงปานกลาง",
                className: "is-medium",
            };
        }

        return {
            level: "low",
            label: "เสี่ยงต่ำ",
            className: "is-low",
        };
    }

    /* =========================
       State
    ========================= */

    function showState(title, message, loading = true) {
        const state = $("historyState");
        const icon = document.querySelector(".history-loading-icon");

        if (!state) {
            return;
        }

        state.hidden = false;

        const content = $("historyContent");

        if (content) {
            content.hidden = true;
        }

        setText("historyStateTitle", title);
        setText("historyStateMessage", message);

        if (icon) {
            icon.style.animation = loading ? "" : "none";
            icon.style.borderTopColor = loading ? "" : "var(--bad, #c93f43)";
        }
    }

    function hideState() {
        const state = $("historyState");

        if (state) {
            state.hidden = true;
        }
    }

    /* =========================
       Format / Utilities
    ========================= */

    function formatDuration(totalSeconds) {
        const seconds = Math.max(0, Math.floor(Number(totalSeconds) || 0));

        const hours = Math.floor(seconds / 3600);
        const minutes = Math.floor((seconds % 3600) / 60);
        const sec = seconds % 60;

        if (hours > 0) {
            if (minutes === 0) {
                return `${hours} ชม.`;
            }

            return `${hours} ชม. ${minutes} นาที`;
        }

        if (minutes > 0) {
            return `${minutes} นาที`;
        }

        return `${sec} วินาที`;
    }

    function formatDateTime(date) {
        if (!date) {
            return "ไม่ทราบเวลา";
        }

        try {
            return new Intl.DateTimeFormat("th-TH", {
                dateStyle: "medium",
                timeStyle: "short",
            }).format(date);
        } catch (_) {
            return date.toLocaleString();
        }
    }

    function formatDateOnly(date) {
        if (!date) {
            return "ไม่ทราบวันที่";
        }

        try {
            return new Intl.DateTimeFormat("th-TH", {
                weekday: "short",
                day: "2-digit",
                month: "short",
                year: "numeric",
            }).format(date);
        } catch (_) {
            return date.toLocaleDateString();
        }
    }

    function getCurrentUserSafe() {
        if (window.utils && typeof utils.getCurrentUser === "function") {
            return utils.getCurrentUser();
        }

        try {
            return JSON.parse(localStorage.getItem("currentUser") || "null");
        } catch (_) {
            return null;
        }
    }

    function getUserId(user) {
        if (!user) {
            return null;
        }

        return user.id || user.user_id || user.userId || null;
    }

    function getApiBase() {
        if (window.utils && utils.API_BASE) {
            return utils.API_BASE;
        }

        if (window.api && api.API_BASE) {
            return api.API_BASE;
        }

        return "http://localhost:8000";
    }

    function setText(id, value) {
        const el = $(id);

        if (!el) {
            return;
        }

        el.textContent = String(value);
    }

    function setWidth(id, percent) {
        const el = $(id);

        if (!el) {
            return;
        }

        el.style.width = `${clamp(percent, 0, 100)}%`;
    }

    function clamp(value, min, max) {
        const n = Number(value);

        if (!Number.isFinite(n)) {
            return min;
        }

        return Math.max(min, Math.min(max, n));
    }

    function escapeHtml(value) {
        return String(value)
            .replaceAll("&", "&amp;")
            .replaceAll("<", "&lt;")
            .replaceAll(">", "&gt;")
            .replaceAll('"', "&quot;")
            .replaceAll("'", "&#039;");
    }
})();