/* =========================================
   Summary Page
   File: frontend/js/summary.js

   - ใช้ข้อมูลจริงจาก SQLite ผ่าน /api/summary
   - fallback เป็น cached summary หรือ /session/summary
   - ไม่ใช้ Calibration / Baseline
   - ไม่ให้คะแนนกับ session ที่ข้อมูลน้อยเกินไป
   - Low-data state ไม่แสดง report เต็มเพื่อไม่ให้ user เข้าใจผิด
   - ไม่เรียกปัญหาเล็กน้อยว่า "ปัญหาหลัก"
   - Session 30–59 วิ ถือเป็นผลเบื้องต้น และไม่ให้คะแนนเกิน 95
========================================= */

(function () {
    "use strict";

    const $ = (id) => document.getElementById(id);

    const SCORE_CIRCUMFERENCE = 326.73;

    const MIN_VALID_EFFECTIVE_SECONDS = 30;
    const PRELIMINARY_EFFECTIVE_SECONDS = 60;
    const PRELIMINARY_MAX_SCORE = 95;

    const MIN_MAIN_ISSUE_PERCENT = 10;
    const HIGH_ISSUE_PERCENT = 30;

    const LAST_SESSION_ID_KEYS = [
        "lastSessionId",
        "postureguard_last_session_id",
        "last_session_id",
    ];

    document.addEventListener("DOMContentLoaded", initSummaryPage);

    async function initSummaryPage() {
        if (!window.api || !window.utils) {
            showState(
                "ระบบ frontend โหลดไม่ครบ",
                "ตรวจสอบว่า summary.html เรียก app.js ก่อน summary.js"
            );

            window.setTimeout(() => {
                window.location.replace("login.html");
            }, 1200);

            return;
        }

        setupActions();
        showState("กำลังโหลดข้อมูล", "ระบบกำลังดึงข้อมูลสรุปล่าสุด");

        try {
            const canViewSummary = await utils.requireSummaryAccess();

            if (!canViewSummary) {
                return;
            }

            await loadSummary();
        } catch (err) {
            console.error("summary init error:", err);

            showState(
                "ไม่สามารถเปิดหน้าสรุปได้",
                "ตรวจสอบว่า backend เปิดอยู่ หรือเข้าสู่ระบบใหม่อีกครั้ง"
            );
        }
    }

    function setupActions() {
        const backMonitoringBtn = $("backMonitoringBtn");
        const startNewSessionBtn = $("startNewSessionBtn");

        if (backMonitoringBtn) {
            backMonitoringBtn.addEventListener("click", async () => {
                const originalText = backMonitoringBtn.textContent;

                backMonitoringBtn.disabled = true;
                backMonitoringBtn.textContent = "กำลังตรวจสอบ...";

                try {
                    if (utils.getBackendSessionStatus) {
                        const status = await utils.getBackendSessionStatus();

                        if (status && status.status === "active") {
                            utils.redirectTo("monitoring.html", { replace: false });
                            return;
                        }
                    }

                    utils.redirectTo("setup.html", { replace: false });
                } catch (err) {
                    console.error("back monitoring error:", err);
                    utils.redirectTo("setup.html", { replace: false });
                } finally {
                    backMonitoringBtn.disabled = false;
                    backMonitoringBtn.textContent = originalText;
                }
            });
        }

        if (startNewSessionBtn) {
            startNewSessionBtn.addEventListener("click", async (event) => {
                event.preventDefault();

                const originalText = startNewSessionBtn.textContent;

                startNewSessionBtn.setAttribute("aria-disabled", "true");
                startNewSessionBtn.style.pointerEvents = "none";
                startNewSessionBtn.textContent = "กำลังตรวจสอบ...";

                try {
                    if (utils.requireNoActiveMonitoring) {
                        const canGoSetup = await utils.requireNoActiveMonitoring();

                        if (!canGoSetup) {
                            return;
                        }
                    }

                    utils.redirectTo("setup.html", { replace: false });
                } catch (err) {
                    console.error("start new session error:", err);

                    showState(
                        "ไม่สามารถเริ่มตรวจใหม่ได้",
                        "ตรวจสอบว่า backend เปิดอยู่ แล้วลองอีกครั้ง"
                    );
                } finally {
                    startNewSessionBtn.removeAttribute("aria-disabled");
                    startNewSessionBtn.style.pointerEvents = "";
                    startNewSessionBtn.textContent = originalText;
                }
            });
        }
    }

    async function loadSummary() {
        const userId = getCurrentUserId();

        if (!userId) {
            showState("ไม่พบข้อมูลผู้ใช้", "กรุณาเข้าสู่ระบบใหม่อีกครั้ง");

            window.setTimeout(() => {
                utils.redirectTo("login.html", { replace: true });
            }, 1000);

            return;
        }

        const cachedSummary = getCachedSummary();
        const lastSessionId = getLastSessionId();

        try {
            const payload = await fetchSummaryFromSQLite(userId, lastSessionId);

            if (payload && payload.summary) {
                renderPage(payload.summary, payload.recent_sessions || []);
                return;
            }

            if (cachedSummary && cachedSummary.session_active !== true) {
                renderPage(cachedSummary, payload?.recent_sessions || []);
                return;
            }

            if (api.getSessionSummary) {
                const liveSummary = await api.getSessionSummary();

                if (liveSummary?.session_active === true) {
                    utils.redirectTo("monitoring.html", { replace: true });
                    return;
                }

                if (liveSummary) {
                    renderPage(liveSummary, payload?.recent_sessions || []);
                    return;
                }
            }

            showState(
                "ยังไม่มีข้อมูลสรุป",
                "ยังไม่พบ session ที่นำมาสรุปได้ ให้เริ่มตรวจใหม่อย่างน้อย 30 วินาที"
            );
        } catch (err) {
            console.error("summary loading error:", err);

            if (cachedSummary && cachedSummary.session_active !== true) {
                renderPage(cachedSummary, []);
                return;
            }

            showState(
                "โหลดสรุปผลไม่สำเร็จ",
                "ตรวจสอบว่า backend เปิดอยู่ และ endpoint /api/summary ใช้งานได้"
            );
        }
    }

    async function fetchSummaryFromSQLite(userId, sessionId) {
        if (api.getSummary) {
            try {
                return await api.getSummary(userId, {
                    sessionId,
                    recentLimit: 5,
                });
            } catch (err) {
                console.warn("Cannot fetch summary with api.getSummary:", err);
            }
        }

        const apiBase = getApiBase();

        const params = new URLSearchParams({
            user_id: String(userId),
            recent_limit: "5",
        });

        if (sessionId) {
            params.set("session_id", String(sessionId));
        }

        try {
            const response = await fetch(`${apiBase}/api/summary?${params.toString()}`, {
                method: "GET",
                headers: {
                    "Content-Type": "application/json",
                },
            });

            if (!response.ok) {
                return null;
            }

            return await response.json();
        } catch (err) {
            console.warn("Cannot fetch /api/summary:", err);
            return null;
        }
    }

    function renderPage(rawSummary, recentSessions) {
        const summary = normalizeSummary(rawSummary);
        const metrics = calculateMetrics(summary);

        hideState();
        showContent();

        applyDataStateLayout(metrics);

        renderMeta(summary);
        renderScore(metrics);
        renderKpis(summary, metrics);
        renderBreakdown(summary, metrics);
        renderInsight(summary, metrics);
        renderRecommendations(summary, metrics);
        renderRecentSessions(recentSessions);
    }

    function applyDataStateLayout(metrics) {
        const issuesCard = document.querySelector(".posture-card");
        const detailGrid = document.querySelector(".summary-detail-grid");

        if (!issuesCard || !detailGrid) {
            return;
        }

        if (!metrics.hasEnoughData) {
            issuesCard.hidden = true;
            detailGrid.classList.add("is-low-data");
            return;
        }

        issuesCard.hidden = false;
        detailGrid.classList.remove("is-low-data");
    }

    function normalizeSummary(raw) {
        const data = raw || {};

        return {
            sessionId: data.session_id ?? data.id ?? null,
            userId: data.user_id ?? null,

            startTime: data.start_time ?? null,
            endTime: data.end_time ?? null,
            completed: Boolean(data.completed ?? data.session_active === false),

            plannedDurationMinutes: number(
                data.planned_duration_minutes ??
                data.planned_duration_min
            ),

            actualDuration: number(data.actual_duration_seconds),
            effectiveSeconds: number(data.effective_seated_seconds),

            goodSeconds: number(
                data.good_posture_seconds ??
                data.good_seconds
            ),

            badSeconds: number(
                data.bad_posture_seconds ??
                data.bad_seconds
            ),

            forwardSeconds: number(data.forward_head_seconds),
            roundedSeconds: number(data.rounded_shoulder_seconds),

            alertCount: number(data.alert_count),
            forwardAlerts: number(data.forward_head_alert_count),
            roundedAlerts: number(data.rounded_shoulder_alert_count),

            badRatio: data.bad_posture_ratio !== undefined && data.bad_posture_ratio !== null
                ? number(data.bad_posture_ratio)
                : null,

            goodRatio: data.good_posture_ratio !== undefined && data.good_posture_ratio !== null
                ? number(data.good_posture_ratio)
                : null,

            riskLevel: String(data.risk_level || "low").toLowerCase(),
        };
    }

    function calculateMetrics(summary) {
        // badSeconds คือเวลาท่าผิดรวมจริง
        // ไม่ใช้ forwardSeconds + roundedSeconds เป็นเวลารวม
        // เพราะถ้าคอยื่นและไหล่ห่อเกิดพร้อมกัน จะทำให้เวลาถูกนับซ้ำ
        const fallbackIssueSeconds = Math.max(
            summary.forwardSeconds,
            summary.roundedSeconds,
            0
        );

        const issueSeconds = summary.badSeconds > 0
            ? Math.max(summary.badSeconds, 0)
            : fallbackIssueSeconds;

        const measuredSeconds = summary.effectiveSeconds > 0
            ? summary.effectiveSeconds
            : Math.max(summary.goodSeconds + issueSeconds, 0);

        const hasEnoughData = measuredSeconds >= MIN_VALID_EFFECTIVE_SECONDS;
        const isPreliminary =
            hasEnoughData && measuredSeconds < PRELIMINARY_EFFECTIVE_SECONDS;

        const totalAlerts = Math.max(
            summary.alertCount,
            summary.forwardAlerts + summary.roundedAlerts
        );

        const goodPct = hasEnoughData
            ? (
                summary.goodRatio !== null
                    ? clamp(summary.goodRatio * 100, 0, 100)
                    : percent(summary.goodSeconds, measuredSeconds)
            )
            : 0;

        const issuePct = hasEnoughData
            ? (
                summary.badRatio !== null
                    ? clamp(summary.badRatio * 100, 0, 100)
                    : percent(issueSeconds, measuredSeconds)
            )
            : 0;

        const forwardPct = hasEnoughData
            ? percent(summary.forwardSeconds, measuredSeconds)
            : 0;

        const roundedPct = hasEnoughData
            ? percent(summary.roundedSeconds, measuredSeconds)
            : 0;

        let score = hasEnoughData
            ? calculateScore({
                issuePct,
                totalAlerts,
            })
            : null;

        if (isPreliminary && Number.isFinite(score)) {
            score = Math.min(score, PRELIMINARY_MAX_SCORE);
        }

        const status = getStatus({
            score,
            issuePct,
            totalAlerts,
            hasEnoughData,
            isPreliminary,
            measuredSeconds,
        });

        return {
            measuredSeconds,
            issueSeconds,
            totalAlerts,

            hasEnoughData,
            isPreliminary,

            goodPct,
            issuePct,
            forwardPct,
            roundedPct,

            score,
            status,
        };
    }

    function calculateScore({ issuePct, totalAlerts }) {
        const issuePenalty = clamp(issuePct, 0, 100) * 0.45;
        const alertPenalty = Math.min(totalAlerts * 8, 35);
        const rawScore = 100 - issuePenalty - alertPenalty;

        return Math.round(clamp(rawScore, 35, 100));
    }

    function getStatus({
        score,
        issuePct,
        totalAlerts,
        hasEnoughData,
        isPreliminary,
        measuredSeconds,
    }) {
        if (!hasEnoughData) {
            const remainingSeconds = Math.max(
                MIN_VALID_EFFECTIVE_SECONDS - Math.floor(measuredSeconds),
                0
            );

            return {
                label: "ข้อมูลน้อย",
                title: "ยังประเมินไม่ได้",
                tone: "warning",
                description: `ตรวจพบผู้ใช้จริง ${formatDuration(measuredSeconds)} ต้องการอีกประมาณ ${remainingSeconds} วิ เพื่อสรุปผลให้เชื่อถือได้`,
            };
        }

        if (score >= 85 && issuePct < 15) {
            return {
                label: "ดี",
                title: "ท่านั่งโดยรวมดี",
                tone: "good",
                description: isPreliminary
                    ? "ผลนี้เป็นเบื้องต้น ท่านั่งดีในช่วงเวลาที่ตรวจพบ แต่ควรตรวจให้นานขึ้นเพื่อยืนยันผล"
                    : "รอบนี้มีท่านั่งปกติเป็นส่วนใหญ่ รักษาระดับสายตาและตำแหน่งไหล่ต่อเนื่อง",
            };
        }

        if (score >= 65 && issuePct < 40) {
            return {
                label: "ควรระวัง",
                title: "ควรระวังท่านั่ง",
                tone: "warning",
                description: totalAlerts > 0
                    ? `พบช่วงท่าทางเสี่ยงและมีการแจ้งเตือน ${totalAlerts} ครั้ง ควรปรับท่าก่อนใช้งานต่อ`
                    : "พบช่วงท่าทางเสี่ยงบางส่วน ควรปรับท่าก่อนใช้งานต่อ",
            };
        }

        return {
            label: "เสี่ยง",
            title: "ควรปรับท่านั่ง",
            tone: "danger",
            description: "พบช่วงท่าทางเสี่ยงค่อนข้างสูง ควรพักและจัดตำแหน่งจอ เก้าอี้ และไหล่ใหม่",
        };
    }

    function renderMeta(summary) {
        const parts = [];

        if (summary.sessionId) {
            parts.push(`Session #${summary.sessionId}`);
        }

        if (summary.startTime) {
            parts.push(`เริ่ม ${formatDateTime(summary.startTime)}`);
        }

        if (summary.endTime) {
            parts.push(`จบ ${formatDateTime(summary.endTime)}`);
        }

        if (!parts.length) {
            parts.push(`อัปเดตล่าสุด ${new Date().toLocaleString("th-TH")}`);
        }

        setText("summaryMeta", parts.join(" · "));
    }

    function renderScore(metrics) {
        const hasScore = metrics.hasEnoughData && Number.isFinite(metrics.score);
        const scoreText = hasScore ? String(metrics.score) : "—";
        const scoreForRing = hasScore ? metrics.score : 0;

        setText("scoreValue", scoreText);
        setText("scoreTitle", metrics.status.title);
        setText("scoreDescription", metrics.status.description);
        setText("overallStatus", metrics.status.label);

        const scoreProgress = $("scoreProgress");
        const scoreValue = $("scoreValue");
        const statusPill = $("overallStatusPill");

        const toneColor = hasScore
            ? getToneColor(metrics.status.tone)
            : "#94a3b8";

        if (scoreProgress) {
            const offset = SCORE_CIRCUMFERENCE - (scoreForRing / 100) * SCORE_CIRCUMFERENCE;

            scoreProgress.style.strokeDasharray = String(SCORE_CIRCUMFERENCE);
            scoreProgress.style.strokeDashoffset = String(offset);
            scoreProgress.style.stroke = toneColor;
        }

        if (scoreValue) {
            scoreValue.style.color = toneColor;
        }

        if (statusPill) {
            statusPill.className = `summary-status-pill is-${metrics.status.tone}`;
        }
    }
    function renderKpis(summary, metrics) {
        setText("totalTimeValue", formatDuration(summary.actualDuration));
        setText("effectiveTimeValue", formatDuration(metrics.measuredSeconds));

        if (!metrics.hasEnoughData) {
            const remainingSeconds = Math.max(
                MIN_VALID_EFFECTIVE_SECONDS - Math.floor(metrics.measuredSeconds),
                0
            );

            updateKpiCard(
                "effectiveTimeValue",
                "ตรวจพบผู้ใช้",
                `ต้องการเพิ่มอีกประมาณ ${remainingSeconds} วิ`
            );

            updateKpiCard(
                "alertCountValue",
                "แจ้งเตือนระหว่างตรวจ",
                "ยังไม่นำไปสรุปคะแนน"
            );

            updateKpiCard(
                "goodPercentValue",
                "ท่านั่งปกติ",
                "ยังประเมินไม่ได้"
            );

            setText("goodPercentValue", "—");
            setText("goodTimeValue", "ยังประเมินไม่ได้");
            setText("alertCountValue", `${metrics.totalAlerts} ครั้ง`);

            return;
        }

        updateKpiCard(
            "effectiveTimeValue",
            "เวลาที่ตรวจพบผู้ใช้",
            "เวลาที่ใช้คำนวณผลจริง"
        );

        updateKpiCard(
            "alertCountValue",
            "แจ้งเตือนรวม",
            "คอยื่นและไหล่ห่อรวมกัน"
        );

        updateKpiCard(
            "goodPercentValue",
            "ท่านั่งปกติ",
            formatDuration(summary.goodSeconds)
        );

        setText("goodPercentValue", `${Math.round(metrics.goodPct)}%`);
        setText("goodTimeValue", formatDuration(summary.goodSeconds));
        setText("alertCountValue", `${metrics.totalAlerts} ครั้ง`);
    }

    function renderBreakdown(summary, metrics) {
        const riskChip = $("riskLevelChip");
        const risk = getRiskLabel(summary.riskLevel, metrics);

        if (riskChip) {
            riskChip.textContent = risk.label;
            riskChip.className = `summary-chip is-${risk.className}`;
        }

        if (!metrics.hasEnoughData) {
            hideNoIssuesState();
            setText("goodBarText", "—");
            setText("goodBarSubtext", "ข้อมูลยังไม่พอ");
            setWidth("goodBar", 0);

            setText("forwardBarText", "—");
            setText(
                "forwardBarSubtext",
                `ตรวจพบผู้ใช้จริง ${formatDuration(metrics.measuredSeconds)} · ต้องการอย่างน้อย ${MIN_VALID_EFFECTIVE_SECONDS} วิ`
            );
            setWidth("forwardBar", 0);

            setText("roundedBarText", "—");
            setText(
                "roundedBarSubtext",
                `ตรวจพบผู้ใช้จริง ${formatDuration(metrics.measuredSeconds)} · ต้องการอย่างน้อย ${MIN_VALID_EFFECTIVE_SECONDS} วิ`
            );
            setWidth("roundedBar", 0);

            return;
        }

        const hasNoIssues =
            metrics.forwardPct <= 0 &&
            metrics.roundedPct <= 0 &&
            summary.forwardSeconds <= 0 &&
            summary.roundedSeconds <= 0 &&
            summary.forwardAlerts <= 0 &&
            summary.roundedAlerts <= 0;

        if (hasNoIssues) {
            showNoIssuesState();
            setText("forwardBarText", "0%");
            setText("forwardBarSubtext", "0วิ · แจ้งเตือน 0 ครั้ง");
            setWidth("forwardBar", 0);

            setText("roundedBarText", "0%");
            setText("roundedBarSubtext", "0วิ · แจ้งเตือน 0 ครั้ง");
            setWidth("roundedBar", 0);
            return;
        }

        hideNoIssuesState();

        setText("goodBarText", `${Math.round(metrics.goodPct)}%`);
        setText("goodBarSubtext", `${formatDuration(summary.goodSeconds)} จากเวลาที่ตรวจพบผู้ใช้`);
        setWidth("goodBar", metrics.goodPct);

        setText("forwardBarText", `${Math.round(metrics.forwardPct)}%`);
        setText(
            "forwardBarSubtext",
            `${formatDuration(summary.forwardSeconds)} · แจ้งเตือน ${summary.forwardAlerts} ครั้ง`
        );
        setWidth("forwardBar", metrics.forwardPct);

        setText("roundedBarText", `${Math.round(metrics.roundedPct)}%`);
        setText(
            "roundedBarSubtext",
            `${formatDuration(summary.roundedSeconds)} · แจ้งเตือน ${summary.roundedAlerts} ครั้ง`
        );
        setWidth("roundedBar", metrics.roundedPct);
    }

    function showNoIssuesState() {
        const postureCard = document.querySelector(".posture-card");
        const bars = document.querySelector(".posture-bars");

        if (!postureCard) {
            return;
        }

        if (bars) {
            bars.hidden = true;
        }

        let empty = postureCard.querySelector(".posture-empty-state");

        if (!empty) {
            empty = document.createElement("div");
            empty.className = "posture-empty-state";
            empty.innerHTML = `
                <strong>ไม่พบปัญหาท่าทางเด่น</strong>
                <p>คอยื่นและไหล่ห่ออยู่ในเกณฑ์ปกติในช่วงเวลาที่ตรวจพบผู้ใช้</p>
            `;

            postureCard.appendChild(empty);
        }

        empty.hidden = false;
    }

    function hideNoIssuesState() {
        const bars = document.querySelector(".posture-bars");
        const empty = document.querySelector(".posture-empty-state");

        if (bars) {
            bars.hidden = false;
        }

        if (empty) {
            empty.hidden = true;
        }
    }

    function renderInsight(summary, metrics) {
        const icon = $("mainIssueIcon");

        setText("forwardTimeValue", formatDuration(summary.forwardSeconds));
        setText("forwardAlertValue", `แจ้งเตือน ${summary.forwardAlerts} ครั้ง`);

        setText("roundedTimeValue", formatDuration(summary.roundedSeconds));
        setText("roundedAlertValue", `แจ้งเตือน ${summary.roundedAlerts} ครั้ง`);

        if (!metrics.hasEnoughData) {
            const remainingSeconds = Math.max(
                MIN_VALID_EFFECTIVE_SECONDS - Math.floor(metrics.measuredSeconds),
                0
            );

            setText("mainIssueTitle", "ยังไม่สรุปปัญหาท่าทาง");
            setText(
                "mainIssueDescription",
                `ตรวจพบผู้ใช้จริง ${formatDuration(metrics.measuredSeconds)} ต้องการอีกประมาณ ${remainingSeconds} วิ เพื่อแยกคอยื่นหรือไหล่ห่อได้แม่นขึ้น`
            );

            if (icon) {
                icon.textContent = "!";
            }

            return;
        }

        const forwardPct = Math.round(metrics.forwardPct);
        const roundedPct = Math.round(metrics.roundedPct);

        const hasForwardIssue =
            summary.forwardSeconds > 0 ||
            summary.forwardAlerts > 0 ||
            metrics.forwardPct > 0;

        const hasRoundedIssue =
            summary.roundedSeconds > 0 ||
            summary.roundedAlerts > 0 ||
            metrics.roundedPct > 0;

        const maxIssuePct = Math.max(metrics.forwardPct, metrics.roundedPct);

        if (maxIssuePct < MIN_MAIN_ISSUE_PERCENT) {
            if (!hasForwardIssue && !hasRoundedIssue && metrics.totalAlerts === 0) {
                setText("mainIssueTitle", "ไม่พบปัญหาเด่น");
                setText(
                    "mainIssueDescription",
                    metrics.isPreliminary
                        ? "ผลนี้เป็นเบื้องต้น ท่าทางดูดีในช่วงเวลาที่ตรวจพบ แต่ควรตรวจให้นานขึ้นเพื่อยืนยันผล"
                        : "รอบนี้ท่าทางโดยรวมอยู่ในเกณฑ์ดี ควรรักษาระดับสายตาและตำแหน่งไหล่ต่อเนื่อง"
                );

                if (icon) {
                    icon.textContent = "✓";
                }

                return;
            }

            if (metrics.forwardPct >= metrics.roundedPct && hasForwardIssue) {
                setText("mainIssueTitle", "มีคอยื่นเล็กน้อย");
                setText(
                    "mainIssueDescription",
                    `พบคอยื่นประมาณ ${forwardPct}% ของเวลาที่ตรวจพบผู้ใช้ ยังไม่ใช่ปัญหาหนัก แต่ควรรักษาระดับสายตาไว้`
                );

                if (icon) {
                    icon.textContent = "คอ";
                }

                return;
            }

            if (hasRoundedIssue) {
                setText("mainIssueTitle", "มีไหล่ห่อเล็กน้อย");
                setText(
                    "mainIssueDescription",
                    `พบไหล่ห่อประมาณ ${roundedPct}% ของเวลาที่ตรวจพบผู้ใช้ ยังไม่ใช่ปัญหาหนัก แต่ควรวางแขนและผ่อนหัวไหล่ให้ดี`
                );

                if (icon) {
                    icon.textContent = "ไหล่";
                }

                return;
            }

            setText("mainIssueTitle", "มีแจ้งเตือนเล็กน้อย");
            setText(
                "mainIssueDescription",
                `มีการแจ้งเตือน ${metrics.totalAlerts} ครั้ง แต่สัดส่วนท่าทางเสี่ยงยังต่ำ ควรสังเกตท่าทางระหว่างใช้งาน`
            );

            if (icon) {
                icon.textContent = "!";
            }

            return;
        }

        const severityText = maxIssuePct >= HIGH_ISSUE_PERCENT
            ? "ปัญหาหลัก"
            : "จุดที่ควรระวัง";

        if (
            summary.forwardAlerts > summary.roundedAlerts ||
            summary.forwardSeconds > summary.roundedSeconds * 1.2 ||
            metrics.forwardPct >= metrics.roundedPct
        ) {
            setText("mainIssueTitle", `${severityText}คือคอยื่น`);
            setText(
                "mainIssueDescription",
                `พบคอยื่นประมาณ ${forwardPct}% ของเวลาที่ตรวจพบผู้ใช้ ควรยกจอให้อยู่ระดับสายตาและดึงคางกลับเบา ๆ`
            );

            if (icon) {
                icon.textContent = "คอ";
            }

            return;
        }

        if (
            summary.roundedAlerts > summary.forwardAlerts ||
            summary.roundedSeconds > summary.forwardSeconds * 1.2 ||
            metrics.roundedPct > metrics.forwardPct
        ) {
            setText("mainIssueTitle", `${severityText}คือไหล่ห่อ`);
            setText(
                "mainIssueDescription",
                `พบไหล่ห่อประมาณ ${roundedPct}% ของเวลาที่ตรวจพบผู้ใช้ ควรเปิดอก วางแขนใกล้ตัว และผ่อนหัวไหล่`
            );

            if (icon) {
                icon.textContent = "ไหล่";
            }

            return;
        }

        setText("mainIssueTitle", "พบทั้งคอและไหล่");
        setText(
            "mainIssueDescription",
            `มีการแจ้งเตือนรวม ${metrics.totalAlerts} ครั้ง ควรปรับทั้งระดับจอ ระยะโต๊ะ และตำแหน่งไหล่`
        );

        if (icon) {
            icon.textContent = "!";
        }
    }

    function renderRecommendations(summary, metrics) {
        const items = [];

        if (!metrics.hasEnoughData) {
            const remainingSeconds = Math.max(
                MIN_VALID_EFFECTIVE_SECONDS - Math.floor(metrics.measuredSeconds),
                0
            );

            items.push(`เริ่มตรวจใหม่และนั่งให้อยู่ในกรอบกล้องอีกอย่างน้อย ${remainingSeconds} วิ`);
            items.push("จัดกล้องด้านข้างให้เห็นศีรษะ คอ ไหล่ และลำตัวชัดเจน");

            renderList("recommendationList", items);
            return;
        }

        if (metrics.score >= 85) {
            items.push("รักษาระดับสายตาให้อยู่ใกล้ขอบบนของหน้าจอ");
            items.push(
                metrics.isPreliminary
                    ? "ควรตรวจต่อให้ครบอย่างน้อย 1 นาที เพื่อให้ผลน่าเชื่อถือขึ้น"
                    : "พักสั้น ๆ ทุก 30–45 นาที หากต้องนั่งทำงานต่อเนื่อง"
            );
        } else if (metrics.score >= 65) {
            items.push("พักสั้น ๆ แล้วเช็กตำแหน่งคอและไหล่ก่อนใช้งานต่อ");
        } else {
            items.push("พักและปรับเก้าอี้ หน้าจอ และระยะคีย์บอร์ดก่อนเริ่ม session ใหม่");
        }

        if (summary.forwardAlerts > 0 || metrics.forwardPct >= 20) {
            items.push("สำหรับคอยื่น: ยกจอให้อยู่ระดับสายตา ลดการก้มมอง และดึงคางกลับเบา ๆ");
        }

        if (summary.roundedAlerts > 0 || metrics.roundedPct >= 20) {
            items.push("สำหรับไหล่ห่อ: วางเมาส์และคีย์บอร์ดให้ใกล้ตัว เปิดอก และผ่อนหัวไหล่");
        }

        if (metrics.totalAlerts > 0 && items.length < 3) {
            items.push("เมื่อมีแจ้งเตือน ควรปรับทันที ไม่ควรรอจนจบ session");
        }

        renderList("recommendationList", items.slice(0, 3));
    }

    function renderRecentSessions(sessions) {
        const list = $("recentSessionList");

        if (!list) {
            return;
        }

        if (!Array.isArray(sessions) || sessions.length === 0) {
            list.innerHTML = `<div class="recent-empty">ยังไม่มีรายการ session ล่าสุดจากฐานข้อมูล</div>`;
            return;
        }

        list.innerHTML = "";

        sessions.slice(0, 5).forEach((item) => {
            const summary = normalizeSummary(item);
            const metrics = calculateMetrics(summary);

            const row = document.createElement("div");
            row.className = "recent-session-item";

            const info = document.createElement("div");

            const title = document.createElement("div");
            title.className = "recent-session-title";
            title.textContent = summary.startTime
                ? formatDateTime(summary.startTime)
                : `Session #${summary.sessionId || "-"}`;

            const meta = document.createElement("div");
            meta.className = "recent-session-meta";

            if (!metrics.hasEnoughData) {
                meta.textContent = `ใช้งาน ${formatDuration(summary.actualDuration)} · ข้อมูลน้อย`;
            } else if (metrics.isPreliminary) {
                meta.textContent = `ใช้งาน ${formatDuration(summary.actualDuration)} · ผลเบื้องต้น`;
            } else {
                meta.textContent = `ใช้งาน ${formatDuration(summary.actualDuration)} · แจ้งเตือน ${metrics.totalAlerts} ครั้ง`;
            }

            info.appendChild(title);
            info.appendChild(meta);

            const score = document.createElement("div");
            score.className = "recent-session-score";
            score.textContent = metrics.hasEnoughData && Number.isFinite(metrics.score)
                ? String(metrics.score)
                : "—";

            row.appendChild(info);
            row.appendChild(score);
            list.appendChild(row);
        });
    }

    function showState(title, message) {
        const state = $("summaryState");
        const content = $("summaryContent");

        if (state) {
            state.hidden = false;
        }

        if (content) {
            content.hidden = true;
        }

        setText("summaryStateTitle", title);
        setText("summaryStateMessage", message);
    }

    function hideState() {
        const state = $("summaryState");

        if (state) {
            state.hidden = true;
        }
    }

    function showContent() {
        const content = $("summaryContent");

        if (content) {
            content.hidden = false;
        }
    }

    function getCurrentUserId() {
        if (utils.getCurrentUserId) {
            const id = utils.getCurrentUserId();

            if (id) {
                return id;
            }
        }

        const keys = [
            "currentUser",
            "postureguard_user",
            "user",
            "auth_user",
        ];

        for (const key of keys) {
            try {
                const raw = localStorage.getItem(key);

                if (!raw) {
                    continue;
                }

                const user = JSON.parse(raw);
                const id = user?.id ?? user?.user_id;

                if (id) {
                    return id;
                }
            } catch (_) {
                // ignore malformed storage
            }
        }

        const directKeys = [
            "user_id",
            "currentUserId",
            "postureguard_user_id",
        ];

        for (const key of directKeys) {
            const id = localStorage.getItem(key);

            if (id) {
                return id;
            }
        }

        return null;
    }

    function getCachedSummary() {
        if (utils.getLastSessionSummary) {
            return utils.getLastSessionSummary();
        }

        const keys = [
            "lastSessionSummary",
            "postureguard_last_session_summary",
        ];

        for (const key of keys) {
            try {
                const raw = localStorage.getItem(key);

                if (!raw) {
                    continue;
                }

                return JSON.parse(raw);
            } catch (_) {
                // ignore malformed cache
            }
        }

        return null;
    }

    function getLastSessionId() {
        if (utils.getLastSessionId) {
            const id = utils.getLastSessionId();

            if (id) {
                return id;
            }
        }

        for (const key of LAST_SESSION_ID_KEYS) {
            const value = localStorage.getItem(key);

            if (value) {
                return value;
            }
        }

        return null;
    }

    function getApiBase() {
        return (
            utils.API_BASE ||
            api.API_BASE ||
            window.API_BASE ||
            "http://127.0.0.1:8000"
        );
    }

    function getRiskLabel(riskLevel, metrics) {
        if (!metrics.hasEnoughData) {
            return {
                label: "ข้อมูลน้อย",
                className: "medium",
            };
        }

        const normalized = String(riskLevel || "").toLowerCase();

        if (normalized === "high" || metrics.status.tone === "danger") {
            return {
                label: "ความเสี่ยงสูง",
                className: "high",
            };
        }

        if (normalized === "medium" || metrics.status.tone === "warning") {
            return {
                label: "ความเสี่ยงปานกลาง",
                className: "medium",
            };
        }

        return {
            label: metrics.isPreliminary ? "ผลเบื้องต้น" : "ความเสี่ยงต่ำ",
            className: "low",
        };
    }

    function getToneColor(tone) {
        if (tone === "danger") {
            return "#c04040";
        }

        if (tone === "warning") {
            return "#c78a1c";
        }

        return "#1d9e75";
    }

    function renderList(id, items) {
        const list = $(id);

        if (!list) {
            return;
        }

        list.innerHTML = "";

        items.forEach((text) => {
            const li = document.createElement("li");
            li.textContent = text;
            list.appendChild(li);
        });
    }

    function updateKpiCard(valueId, labelText, helperText) {
        const valueEl = $(valueId);

        if (!valueEl) {
            return;
        }

        const card = valueEl.closest(".summary-kpi-card");

        if (!card) {
            return;
        }

        const label = card.querySelector(".kpi-label");
        const helper = card.querySelector("small");

        if (label) {
            label.textContent = labelText;
        }

        if (helper) {
            helper.textContent = helperText;
        }
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

    function setWidth(id, percentValue) {
        const el = $(id);

        if (!el) {
            return;
        }

        el.style.width = `${clamp(percentValue, 0, 100)}%`;
    }

    function number(value) {
        const n = Number(value);
        return Number.isFinite(n) ? n : 0;
    }

    function percent(value, total) {
        const n = number(value);
        const t = number(total);

        if (t <= 0) {
            return 0;
        }

        return clamp((n / t) * 100, 0, 100);
    }

    function clamp(value, min, max) {
        return Math.max(min, Math.min(max, Number(value) || 0));
    }

    function formatDuration(totalSeconds) {
        const seconds = Math.max(0, Math.floor(number(totalSeconds)));
        const hours = Math.floor(seconds / 3600);
        const minutes = Math.floor((seconds % 3600) / 60);
        const secs = seconds % 60;

        if (hours > 0) {
            return `${hours}ชม. ${minutes}น.`;
        }

        if (minutes > 0) {
            return `${minutes}น. ${secs}วิ`;
        }

        return `${secs}วิ`;
    }

    function formatDateTime(value) {
        if (!value) {
            return "";
        }

        const normalized = String(value).replace(" ", "T");
        const date = new Date(normalized);

        if (Number.isNaN(date.getTime())) {
            return String(value);
        }

        return date.toLocaleString("th-TH", {
            day: "2-digit",
            month: "short",
            year: "numeric",
            hour: "2-digit",
            minute: "2-digit",
        });
    }
})();