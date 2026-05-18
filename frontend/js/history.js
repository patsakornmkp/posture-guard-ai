/* =========================================
   History Page
   File: frontend/js/history.js

   เวอร์ชันใหม่:
   - ใช้ CVA สำหรับคอยื่น
   - ใช้ FSA สำหรับไหล่ห่อ
   - ไม่มี warning / เฝ้าระวัง
   - ไม่มีหลังคร่อม / hunched back
   - แสดงจำนวนแจ้งเตือนรวม
   - รองรับจำนวนแจ้งเตือนแยกคอยื่น / ไหล่ห่อ
========================================= */

(function () {
    "use strict";

    const $ = (id) => document.getElementById(id);

    let allSessions = [];

    document.addEventListener("DOMContentLoaded", async () => {
        const user = utils.requireAuth();
        if (!user) return;

        setupControls();

        try {
            const result = await api.getHistory(user.id, 50);
            allSessions = normalizeSessions(result.sessions || []);

            renderHistoryPage();
        } catch (err) {
            console.error("history load error:", err);
            renderError();
        }
    });

    /* =========================
       Controls
    ========================= */

    function setupControls() {
        const riskFilter = $("riskFilter");
        const sortMode = $("sortMode");

        if (riskFilter) {
            riskFilter.addEventListener("change", renderHistoryPage);
        }

        if (sortMode) {
            sortMode.addEventListener("change", renderHistoryPage);
        }
    }

    /* =========================
       Normalize Data
    ========================= */

    function normalizeSessions(sessions) {
        return sessions
            .filter((session) => session.end_time !== null && session.end_time !== undefined)
            .map((session) => {
                const good = getNumber(
                    session.good_seconds,
                    session.good_posture_seconds,
                    session.good,
                    0
                );

                const forward = getNumber(
                    session.forward_head_seconds,
                    session.forward,
                    0
                );

                const rounded = getNumber(
                    session.rounded_shoulder_seconds,
                    session.rounded,
                    0
                );

                const effective = getNumber(
                    session.effective_seated_seconds,
                    session.effective,
                    good + forward + rounded,
                    0
                );

                const actualDuration = getNumber(
                    session.actual_duration_seconds,
                    session.actualDuration,
                    getDurationFromDates(session.start_time, session.end_time),
                    effective,
                    0
                );

                const alertCount = getNumber(
                    session.alert_count,
                    session.alertCount,
                    0
                );

                const forwardAlertCount = getNumber(
                    session.forward_head_alert_count,
                    session.forwardHeadAlertCount,
                    0
                );

                const roundedAlertCount = getNumber(
                    session.rounded_shoulder_alert_count,
                    session.roundedShoulderAlertCount,
                    0
                );

                const riskLevel = normalizeRisk(
                    session.risk_level || session.riskLevel,
                    good,
                    forward,
                    rounded
                );

                return {
                    id: session.id || session.session_id || "",
                    startTime: session.start_time,
                    endTime: session.end_time,
                    good,
                    forward,
                    rounded,
                    effective,
                    actualDuration,
                    alertCount,
                    forwardAlertCount,
                    roundedAlertCount,
                    riskLevel,
                };
            });
    }

    /* =========================
       Main Render
    ========================= */

    function renderHistoryPage() {
        const completed = [...allSessions];

        if (completed.length === 0) {
            renderEmptyState();
            return;
        }

        renderStats(completed);
        renderOverviewChart(completed);
        renderTrendLineChart(completed);

        const filtered = applyFilterAndSort(completed);

        const toolbar = $("historyToolbar");
        if (toolbar) toolbar.hidden = false;

        const count = $("historyCount");
        if (count) {
            count.textContent = `${filtered.length} รายการ`;
        }

        if (filtered.length === 0) {
            const list = $("historyList");
            if (!list) return;

            list.innerHTML = `
                <div class="empty-state">
                    <span class="empty-state-title">ไม่พบข้อมูลตามตัวกรอง</span>
                    <span class="empty-state-desc">
                        ลองเปลี่ยนตัวกรองระดับความเสี่ยงเพื่อดูรายการอื่น
                    </span>
                </div>
            `;
            return;
        }

        const list = $("historyList");
        if (list) {
            list.innerHTML = filtered.map(renderSessionCard).join("");
        }
    }

    /* =========================
       Summary Cards
    ========================= */

    function renderStats(sessions) {
        let totalEffective = 0;
        let totalGood = 0;
        let totalAlerts = 0;

        sessions.forEach((s) => {
            totalEffective += s.effective;
            totalGood += s.good;
            totalAlerts += s.alertCount;
        });

        const avgGoodPct = totalEffective > 0
            ? (totalGood / totalEffective) * 100
            : 0;

        const stats = $("historyStats");
        if (stats) stats.hidden = false;

        setText("histTotalSessions", `${sessions.length} ครั้ง`);
        setText("histTotalTime", formatLongTime(totalEffective));
        setText("histAvgGood", `${avgGoodPct.toFixed(0)}%`);
        setText("histTotalAlerts", `${totalAlerts} ครั้ง`);
    }

    /* =========================
       Overview Chart
    ========================= */

    function renderOverviewChart(sessions) {
        const overview = $("historyOverview");
        if (!overview) return;

        let totalGood = 0;
        let totalForward = 0;
        let totalRounded = 0;

        sessions.forEach((s) => {
            totalGood += s.good;
            totalForward += s.forward;
            totalRounded += s.rounded;
        });

        const total = totalGood + totalForward + totalRounded;

        if (total <= 0) {
            overview.hidden = true;
            return;
        }

        const goodPct = percent(totalGood, total);
        const forwardPct = percent(totalForward, total);
        const roundedPct = percent(totalRounded, total);

        overview.hidden = false;

        setText("overviewGoodScore", `${goodPct.toFixed(0)}%`);
        setText("overviewGoodPct", `${goodPct.toFixed(0)}%`);
        setText("overviewForwardPct", `${forwardPct.toFixed(0)}%`);
        setText("overviewRoundedPct", `${roundedPct.toFixed(0)}%`);

        setWidth("overviewGoodBar", goodPct);
        setWidth("overviewForwardBar", forwardPct);
        setWidth("overviewRoundedBar", roundedPct);

        setText(
            "overviewInsight",
            buildOverviewInsight(goodPct, forwardPct, roundedPct)
        );
    }

    function buildOverviewInsight(goodPct, forwardPct, roundedPct) {
        if (goodPct >= 85) {
            return "แนวโน้มโดยรวมอยู่ในเกณฑ์ปกติ ผู้ใช้มีท่าทางปกติเป็นส่วนใหญ่ ควรรักษาพฤติกรรมนี้ต่อไป";
        }

        if (forwardPct >= roundedPct && forwardPct >= 20) {
            return "แนวโน้มหลักคือค่ามุมคอไม่อยู่ในเกณฑ์ปกติ ควรปรับหน้าจอให้อยู่ระดับสายตา และดึงคางกลับเป็นระยะ";
        }

        if (roundedPct > forwardPct && roundedPct >= 20) {
            return "แนวโน้มหลักคือค่ามุมไหล่ไม่อยู่ในเกณฑ์ปกติ ควรเปิดอก ดึงหัวไหล่กลับ และจัดตำแหน่งไหล่ให้เหมาะสม";
        }

        return "พบช่วงเวลาที่ค่ามุมไม่อยู่ในเกณฑ์ปกติเล็กน้อย ควรพักเป็นระยะและรักษาท่านั่งให้อยู่ในเกณฑ์ปกติ";
    }

    /* =========================
       Trend Chart
    ========================= */

    function renderTrendLineChart(sessions) {
        const trend = $("historyTrend");
        const chart = $("trendChart");

        if (!trend || !chart) return;

        const pointsData = [...sessions]
            .sort((a, b) => getTimeValue(a.startTime) - getTimeValue(b.startTime))
            .slice(-10)
            .map((session, index) => {
                const total = Math.max(
                    session.good + session.forward + session.rounded,
                    session.effective,
                    1
                );

                return {
                    index,
                    date: session.startTime,
                    goodPct: percent(session.good, total),
                };
            });

        if (pointsData.length < 2) {
            trend.hidden = true;
            return;
        }

        trend.hidden = false;

        const latest = pointsData[pointsData.length - 1];

        setText("trendLatestScore", `${latest.goodPct.toFixed(0)}%`);
        setText("trendNote", buildTrendInsight(pointsData));

        chart.innerHTML = buildTrendSvg(pointsData);
    }

    function buildTrendSvg(pointsData) {
        const width = 720;
        const height = 260;

        const padding = {
            top: 24,
            right: 26,
            bottom: 42,
            left: 46,
        };

        const chartWidth = width - padding.left - padding.right;
        const chartHeight = height - padding.top - padding.bottom;

        const xStep = pointsData.length > 1
            ? chartWidth / (pointsData.length - 1)
            : chartWidth;

        const getX = (index) => padding.left + index * xStep;

        const getY = (value) => {
            const safeValue = clamp(value, 0, 100);
            return padding.top + chartHeight - (safeValue / 100) * chartHeight;
        };

        const points = pointsData.map((item, index) => {
            return {
                x: getX(index),
                y: getY(item.goodPct),
                value: item.goodPct,
                label: formatShortDate(item.date),
            };
        });

        const linePath = points
            .map((p, index) => `${index === 0 ? "M" : "L"} ${p.x} ${p.y}`)
            .join(" ");

        const areaPath = `
            ${linePath}
            L ${points[points.length - 1].x} ${padding.top + chartHeight}
            L ${points[0].x} ${padding.top + chartHeight}
            Z
        `;

        const gridLines = [0, 25, 50, 75, 100].map((value) => {
            const y = getY(value);

            return `
                <line x1="${padding.left}" y1="${y}" x2="${width - padding.right}" y2="${y}"
                    stroke="rgba(0,0,0,0.08)" stroke-width="1" />
                <text x="12" y="${y + 4}" font-size="11" fill="#9a9a9a">${value}%</text>
            `;
        }).join("");

        const xLabels = points.map((p, index) => {
            if (points.length > 6 && index % 2 !== 0 && index !== points.length - 1) {
                return "";
            }

            return `
                <text x="${p.x}" y="${height - 14}" text-anchor="middle"
                    font-size="11" fill="#9a9a9a">${p.label}</text>
            `;
        }).join("");

        const circles = points.map((p) => {
            return `
                <circle cx="${p.x}" cy="${p.y}" r="5"
                    fill="var(--accent)" stroke="#ffffff" stroke-width="2">
                    <title>${p.value.toFixed(0)}%</title>
                </circle>
                <text x="${p.x}" y="${p.y - 12}" text-anchor="middle"
                    font-size="11" font-weight="700" fill="var(--fg)">
                    ${p.value.toFixed(0)}%
                </text>
            `;
        }).join("");

        return `
            ${gridLines}

            <path d="${areaPath}"
                fill="var(--accent-bg)"
                opacity="0.85"></path>

            <path d="${linePath}"
                fill="none"
                stroke="var(--accent)"
                stroke-width="3"
                stroke-linecap="round"
                stroke-linejoin="round"></path>

            ${circles}
            ${xLabels}
        `;
    }

    function buildTrendInsight(pointsData) {
        const first = pointsData[0].goodPct;
        const last = pointsData[pointsData.length - 1].goodPct;
        const diff = last - first;

        if (diff >= 10) {
            return "แนวโน้มท่าทางปกติเพิ่มขึ้นอย่างชัดเจน ผู้ใช้ควรรักษาพฤติกรรมนี้ต่อไป";
        }

        if (diff >= 3) {
            return "แนวโน้มท่าทางปกติดีขึ้นเล็กน้อย แสดงว่าผู้ใช้เริ่มปรับพฤติกรรมการนั่งได้ดีขึ้น";
        }

        if (diff <= -10) {
            return "แนวโน้มท่าทางปกติลดลง ควรตรวจสอบตำแหน่งหน้าจอ เก้าอี้ และพฤติกรรมการนั่งระหว่างใช้งาน";
        }

        if (diff <= -3) {
            return "แนวโน้มท่าทางปกติลดลงเล็กน้อย ควรหลีกเลี่ยงการนั่งต่อเนื่องนานเกินไปและพักเป็นระยะ";
        }

        return "แนวโน้มท่าทางค่อนข้างคงที่ ควรรักษาท่านั่งให้อยู่ในเกณฑ์ปกติและพักสายตาเป็นระยะ";
    }

    /* =========================
       Filter / Sort
    ========================= */

    function applyFilterAndSort(sessions) {
        const riskValue = $("riskFilter")?.value || "all";
        const sortValue = $("sortMode")?.value || "latest";

        let result = [...sessions];

        if (riskValue !== "all") {
            result = result.filter((s) => s.riskLevel === riskValue);
        }

        const riskScore = {
            high: 3,
            medium: 2,
            low: 1,
        };

        result.sort((a, b) => {
            if (sortValue === "risk") {
                return (riskScore[b.riskLevel] || 0) - (riskScore[a.riskLevel] || 0);
            }

            if (sortValue === "alerts") {
                return b.alertCount - a.alertCount;
            }

            return getTimeValue(b.startTime) - getTimeValue(a.startTime);
        });

        return result;
    }

    /* =========================
       Session Card
    ========================= */

    function renderSessionCard(session) {
        const dateLabel = formatDate(session.startTime);
        const durationLabel = formatTime(session.effective || session.actualDuration);
        const riskLabel = getRiskLabel(session.riskLevel);

        const totalForPercent = Math.max(
            session.good + session.forward + session.rounded,
            session.effective,
            1
        );

        const goodPct = percent(session.good, totalForPercent);
        const forwardPct = percent(session.forward, totalForPercent);
        const roundedPct = percent(session.rounded, totalForPercent);

        const mainIssue = getMainIssue({
            goodPct,
            forwardPct,
            roundedPct,
            alertCount: session.alertCount,
            forwardAlertCount: session.forwardAlertCount,
            roundedAlertCount: session.roundedAlertCount,
        });

        return `
            <article class="history-card">
                <div class="hcard-top">
                    <div class="hcard-date">
                        <span class="hcard-date-main">${dateLabel.main}</span>
                        <span class="hcard-date-sub">${dateLabel.sub}</span>
                    </div>

                    <span class="history-risk-badge risk-${session.riskLevel}">
                        ${riskLabel}
                    </span>
                </div>

                <div class="hcard-summary">
                    <div class="hmini">
                        <span class="hmini-label">เวลานั่งจริง</span>
                        <span class="hmini-value">${durationLabel}</span>
                    </div>

                    <div class="hmini">
                        <span class="hmini-label">ท่าทางปกติ</span>
                        <span class="hmini-value">${goodPct.toFixed(0)}%</span>
                    </div>

                    <div class="hmini">
                        <span class="hmini-label">แจ้งเตือนรวม</span>
                        <span class="hmini-value">${session.alertCount} ครั้ง</span>
                    </div>
                </div>

                <div class="hcard-bar" aria-label="สัดส่วนท่าทาง">
                    <div class="hcard-bar-good" style="width:${clamp(goodPct, 0, 100)}%"></div>
                    <div class="hcard-bar-forward" style="width:${clamp(forwardPct, 0, 100)}%"></div>
                    <div class="hcard-bar-rounded" style="width:${clamp(roundedPct, 0, 100)}%"></div>
                </div>

                <div class="hcard-breakdown">
                    <span>
                        <i class="history-dot dot-good"></i>
                        ท่าทางปกติ ${goodPct.toFixed(0)}%
                    </span>

                    <span>
                        <i class="history-dot dot-forward"></i>
                        คอยื่น ${forwardPct.toFixed(0)}%
                        · ${session.forwardAlertCount} ครั้ง
                    </span>

                    <span>
                        <i class="history-dot dot-rounded"></i>
                        ไหล่ห่อ ${roundedPct.toFixed(0)}%
                        · ${session.roundedAlertCount} ครั้ง
                    </span>
                </div>

                <div class="hcard-insight">
                    <strong>${mainIssue.title}</strong>
                    <span>${mainIssue.desc}</span>
                </div>
            </article>
        `;
    }

    function getMainIssue({
        goodPct,
        forwardPct,
        roundedPct,
        alertCount,
        forwardAlertCount,
        roundedAlertCount,
    }) {
        if (goodPct >= 85 && alertCount <= 1) {
            return {
                title: "แนวโน้มโดยรวมอยู่ในเกณฑ์ปกติ",
                desc: "ผู้ใช้มีท่าทางปกติเป็นส่วนใหญ่ ควรรักษาระดับสายตาและท่านั่งให้คงที่",
            };
        }

        if (forwardAlertCount > roundedAlertCount && forwardAlertCount > 0) {
            return {
                title: "ประเด็นหลัก: คอยื่น",
                desc: `มีการแจ้งเตือนคอยื่น ${forwardAlertCount} ครั้ง ควรปรับหน้าจอให้อยู่ใกล้ระดับสายตาและดึงคางกลับเป็นระยะ`,
            };
        }

        if (roundedAlertCount > forwardAlertCount && roundedAlertCount > 0) {
            return {
                title: "ประเด็นหลัก: ไหล่ห่อ",
                desc: `มีการแจ้งเตือนไหล่ห่อ ${roundedAlertCount} ครั้ง ควรเปิดอก ดึงหัวไหล่กลับ และผ่อนคลายกล้ามเนื้อไหล่เป็นระยะ`,
            };
        }

        if (forwardPct >= roundedPct && forwardPct >= 15) {
            return {
                title: "ประเด็นหลัก: คอยื่น",
                desc: "ค่ามุมคอไม่อยู่ในเกณฑ์ปกติเป็นหลัก ควรปรับหน้าจอให้อยู่ระดับสายตา",
            };
        }

        if (roundedPct > forwardPct && roundedPct >= 15) {
            return {
                title: "ประเด็นหลัก: ไหล่ห่อ",
                desc: "ค่ามุมไหล่ไม่อยู่ในเกณฑ์ปกติเป็นหลัก ควรเปิดอกและจัดตำแหน่งไหล่ให้เหมาะสม",
            };
        }

        if (alertCount >= 5) {
            return {
                title: "มีการแจ้งเตือนค่อนข้างบ่อย",
                desc: "ควรลดระยะเวลานั่งต่อเนื่อง และเพิ่มช่วงพักสั้น ๆ ระหว่างใช้งาน",
            };
        }

        return {
            title: "พบค่ามุมไม่อยู่ในเกณฑ์ปกติเล็กน้อย",
            desc: "ยังไม่รุนแรงมาก แต่ควรรักษาท่านั่งให้อยู่ในเกณฑ์ปกติและพักสายตาเป็นระยะ",
        };
    }

    /* =========================
       Empty / Error
    ========================= */

    function renderEmptyState() {
        hideSummarySections();

        const list = $("historyList");
        if (!list) return;

        list.innerHTML = `
            <div class="empty-state">
                <span class="empty-state-title">ยังไม่มีประวัติการใช้งาน</span>
                <span class="empty-state-desc">
                    เริ่มรอบการใช้งานครั้งแรก เพื่อให้ระบบบันทึกผลการตรวจจับท่าทางและแสดงแนวโน้มย้อนหลัง
                </span>
                <a href="setup.html" class="btn-primary">เริ่มใช้งาน</a>
            </div>
        `;
    }

    function renderError() {
        hideSummarySections();

        const list = $("historyList");
        if (!list) return;

        list.innerHTML = `
            <div class="empty-state">
                <span class="empty-state-title">โหลดประวัติไม่สำเร็จ</span>
                <span class="empty-state-desc">
                    โปรดตรวจสอบว่า backend เปิดอยู่ และ endpoint ประวัติการใช้งานทำงานถูกต้อง
                </span>
            </div>
        `;
    }

    function hideSummarySections() {
        const stats = $("historyStats");
        const overview = $("historyOverview");
        const trend = $("historyTrend");
        const toolbar = $("historyToolbar");

        if (stats) stats.hidden = true;
        if (overview) overview.hidden = true;
        if (trend) trend.hidden = true;
        if (toolbar) toolbar.hidden = true;
    }

    /* =========================
       Helpers
    ========================= */

    function normalizeRisk(value, good, forward, rounded) {
        if (value === "high" || value === "medium" || value === "low") {
            return value;
        }

        const total = good + forward + rounded;

        if (total <= 0) {
            return "low";
        }

        const riskRatio = (forward + rounded) / total;

        if (riskRatio >= 0.5) return "high";
        if (riskRatio >= 0.2) return "medium";
        return "low";
    }

    function getRiskLabel(riskLevel) {
        const map = {
            low: "ต่ำ",
            medium: "ปานกลาง",
            high: "สูง",
        };

        return map[riskLevel] || "ต่ำ";
    }

    function getNumber(...values) {
        for (const value of values) {
            const num = Number(value);

            if (!Number.isNaN(num) && Number.isFinite(num)) {
                return num;
            }
        }

        return 0;
    }

    function percent(value, total) {
        if (!total || total <= 0) return 0;
        return (Number(value) / Number(total)) * 100;
    }

    function clamp(value, min, max) {
        return Math.max(min, Math.min(max, value));
    }

    function setWidth(id, value) {
        const el = $(id);
        if (!el) return;

        const safeValue = clamp(value, 0, 100);
        el.style.width = `${safeValue}%`;
    }

    function setText(id, value) {
        const el = $(id);
        if (!el) return;

        el.textContent = value;
    }

    function formatDate(dateString) {
        if (!dateString) {
            return {
                main: "ไม่ทราบวันที่",
                sub: "ไม่ทราบเวลา",
            };
        }

        const safeDateString = String(dateString).endsWith("Z")
            ? dateString
            : `${dateString}Z`;

        const date = new Date(safeDateString);

        if (Number.isNaN(date.getTime())) {
            return {
                main: "ไม่ทราบวันที่",
                sub: "ไม่ทราบเวลา",
            };
        }

        return {
            main: date.toLocaleDateString("th-TH", {
                year: "numeric",
                month: "short",
                day: "numeric",
            }),
            sub: date.toLocaleTimeString("th-TH", {
                hour: "2-digit",
                minute: "2-digit",
            }),
        };
    }

    function formatShortDate(dateString) {
        if (!dateString) return "-";

        const safeDateString = String(dateString).endsWith("Z")
            ? dateString
            : `${dateString}Z`;

        const date = new Date(safeDateString);

        if (Number.isNaN(date.getTime())) {
            return "-";
        }

        return date.toLocaleDateString("th-TH", {
            day: "numeric",
            month: "short",
        });
    }

    function getTimeValue(dateString) {
        if (!dateString) return 0;

        const safeDateString = String(dateString).endsWith("Z")
            ? dateString
            : `${dateString}Z`;

        const date = new Date(safeDateString);
        return Number.isNaN(date.getTime()) ? 0 : date.getTime();
    }

    function getDurationFromDates(start, end) {
        if (!start || !end) return 0;

        const startTime = getTimeValue(start);
        const endTime = getTimeValue(end);

        if (!startTime || !endTime || endTime <= startTime) {
            return 0;
        }

        return (endTime - startTime) / 1000;
    }

    function formatTime(totalSeconds) {
        const s = Math.floor(Number(totalSeconds) || 0);
        const h = Math.floor(s / 3600);
        const m = Math.floor((s % 3600) / 60);
        const sec = s % 60;

        if (h > 0) {
            return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
        }

        return `${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
    }

    function formatLongTime(totalSeconds) {
        const s = Math.floor(Number(totalSeconds) || 0);
        const h = Math.floor(s / 3600);
        const m = Math.floor((s % 3600) / 60);

        if (h > 0) {
            return `${h} ชม. ${m} นาที`;
        }

        return `${m} นาที`;
    }
})();