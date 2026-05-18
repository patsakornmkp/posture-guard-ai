/* ==========================================
   PostureGuard — Dashboard logic (rich version)
   ========================================== */

const state = {
    user: null,
    sessionId: null,
    plannedMinutes: 30,
    startTime: null,
    running: false,
    videoInterval: null,
    pollInterval: null,
    elapsedInterval: null,
    alertShownUntil: 0,
    lastSummary: null,         // เก็บ summary ล่าสุดเพื่อเปรียบเทียบ
    cachedSessions: [],        // sessions ที่โหลดมาแล้ว
};

const $ = (id) => document.getElementById(id);

// Safe DOM helpers — ไม่ crash ถ้า element ไม่มีในหน้า
const safeText = (el, value) => { if (el) el.textContent = value; };
const safeClass = (el, value) => { if (el) el.className = value; };
const safeStyle = (el, prop, value) => { if (el) el.style[prop] = value; };
const safeHTML = (el, value) => { if (el) el.innerHTML = value; };
const safeHidden = (el, value) => { if (el) el.hidden = value; };

const dom = {
    userName: $('userName'),
    logoutBtn: $('logoutBtn'),

    setupPanel: $('setupPanel'),
    durationGroup: $('durationGroup'),
    startBtn: $('startBtn'),

    activeSession: $('activeSession'),
    videoFeed: $('videoFeed'),
    elapsedTime: $('elapsedTime'),
    plannedTime: $('plannedTime'),

    statusCard: $('statusCard'),
    statusBadge: $('statusBadge'),
    statusMessage: $('statusMessage'),

    cvaValue: $('cvaValue'),
    hunchedValue: $('hunchedValue'),

    goodTime: $('goodTime'),
    warningTime: $('warningTime'),
    badTime: $('badTime'),
    alertCount: $('alertCount'),

    stopBtn: $('stopBtn'),
    alertToast: $('alertToast'),
    alertText: $('alertText'),

    // Summary
    summaryPanel: $('summaryPanel'),
    summaryDate: $('summaryDate'),
    scoreValue: $('scoreValue'),
    scoreCircleFg: $('scoreCircleFg'),
    scoreEmoji: $('scoreEmoji'),
    scoreGrade: $('scoreGrade'),
    scoreMessage: $('scoreMessage'),

    donutGood: $('donutGood'),
    donutWarn: $('donutWarn'),
    donutBad: $('donutBad'),
    donutCenter: $('donutCenter'),

    legendGood: $('legendGood'),
    legendWarn: $('legendWarn'),
    legendBad: $('legendBad'),

    sumDuration: $('sumDuration'),
    sumGood: $('sumGood'),
    sumGoodPct: $('sumGoodPct'),
    sumWarn: $('sumWarn'),
    sumWarnPct: $('sumWarnPct'),
    sumBad: $('sumBad'),
    sumBadPct: $('sumBadPct'),
    sumAlerts: $('sumAlerts'),
    sumRisk: $('sumRisk'),
    riskCardSummary: $('riskCardSummary'),

    forwardHeadCount: $('forwardHeadCount'),
    hunchedCount: $('hunchedCount'),
    forwardHeadFill: $('forwardHeadFill'),
    hunchedFill: $('hunchedFill'),
    issueNote: $('issueNote'),

    compareCard: $('compareCard'),
    cmpGoodArrow: $('cmpGoodArrow'),
    cmpGoodText: $('cmpGoodText'),
    cmpAlertArrow: $('cmpAlertArrow'),
    cmpAlertText: $('cmpAlertText'),

    recList: $('recList'),
    backBtn: $('backBtn'),

    // History
    historyPanel: $('historyPanel'),
    historyList: $('historyList'),
    historyStats: $('historyStats'),
    histTotalSessions: $('histTotalSessions'),
    histTotalTime: $('histTotalTime'),
    histAvgGood: $('histAvgGood'),
    histTotalAlerts: $('histTotalAlerts'),
    trendCard: $('trendCard'),
    trendSvg: $('trendSvg'),
};

// ---------- Init ----------
document.addEventListener('DOMContentLoaded', () => {
    state.user = utils.requireAuth();
    if (!state.user) return;

    safeText(dom.userName, `สวัสดี, ${state.user.full_name || state.user.username}`);

    dom.logoutBtn.addEventListener('click', utils.logout);
    dom.startBtn.addEventListener('click', startSession);
    dom.stopBtn.addEventListener('click', stopSession);
    dom.backBtn.addEventListener('click', showSetupPanel);

    dom.durationGroup.addEventListener('click', (e) => {
        if (!e.target.matches('.duration-btn')) return;
        document.querySelectorAll('.duration-btn').forEach(b => b.classList.remove('active'));
        e.target.classList.add('active');
        state.plannedMinutes = parseInt(e.target.dataset.minutes);
    });

    loadHistory();
});

// ---------- Start Session ----------
async function startSession() {
    dom.startBtn.disabled = true;
    safeText(dom.startBtn, 'กำลังเริ่ม...');

    try {
        try { await api.stopSession(); } catch (_) {}
        try { await api.stopCamera(); } catch (_) {}

        await api.startCamera();
        const result = await api.startSession(state.user.id, state.plannedMinutes);

        state.sessionId = result.session_id;
        state.startTime = Date.now();
        state.running = true;

        safeHidden(dom.setupPanel, true);
        safeHidden(dom.summaryPanel, true);
        safeHidden(dom.historyPanel, true);
        safeHidden(dom.activeSession, false);
        safeText(dom.plannedTime, formatTime(state.plannedMinutes * 60));

        startPolling();
    } catch (err) {
        alert('ไม่สามารถเริ่ม session ได้: ' + err.message);
    } finally {
        dom.startBtn.disabled = false;
        safeText(dom.startBtn, '▶ เริ่มการใช้งาน');
    }
}

// ---------- Stop Session ----------
async function stopSession() {
    if (!state.running) return;
    dom.stopBtn.disabled = true;
    safeText(dom.stopBtn, 'กำลังหยุด...');

    let summary = null;
    try {
        stopPolling();

        // พยายาม stop session — ถ้า fail ก็ไม่ throw (เผื่อ backend สั่ง stop ไปแล้ว)
        try {
            summary = await api.stopSession();
        } catch (err) {
            console.warn('stop session failed (อาจจะ stop ไปแล้ว):', err.message);
            // ดึง summary ปัจจุบันแทน
            try {
                summary = await api.getSessionSummary();
            } catch (_) {}
        }

        // ปิดกล้อง — ไม่ throw ถ้า fail
        try { await api.stopCamera(); } catch (_) {}

        // ดึง logs เพื่อนับ issue type
        let logs = [];
        try {
            const r = await api.getSessionLogs(state.sessionId);
            logs = r.logs || [];
        } catch (_) {}

        state.running = false;
        const lastId = state.sessionId;
        state.sessionId = null;

        // ถ้ามี summary แสดง ถ้าไม่มี กลับหน้า setup
        if (summary) {
            await showSummary(summary, logs, lastId);
            loadHistory();
        } else {
            showSetupPanel();
        }
    } catch (err) {
        console.error('stop session unexpected error:', err);
        // กลับหน้า setup เป็น fallback
        state.running = false;
        state.sessionId = null;
        showSetupPanel();
    } finally {
        dom.stopBtn.disabled = false;
        safeHTML(dom.stopBtn, '⏹ หยุดการใช้งาน');
    }
}

// ---------- Polling ----------
function startPolling() {
    state.videoInterval = setInterval(() => {
        dom.videoFeed.src = api.videoFrameUrl();
    }, 200);

    state.pollInterval = setInterval(updatePosture, 1000);
    updatePosture();

    state.elapsedInterval = setInterval(updateElapsedTime, 1000);
    updateElapsedTime();
}

function stopPolling() {
    clearInterval(state.videoInterval);
    clearInterval(state.pollInterval);
    clearInterval(state.elapsedInterval);
    state.videoInterval = null;
    state.pollInterval = null;
    state.elapsedInterval = null;
}

async function updatePosture() {
    try {
        const [posture, summary] = await Promise.all([
            api.getCurrentPosture(),
            api.getSessionSummary(),
        ]);
        renderPosture(posture);
        renderActiveStats(summary);
        if (posture.alert) showAlertToast(posture.message);
    } catch (err) {
        console.error('polling error:', err);
    }
}

function updateElapsedTime() {
    if (!state.startTime) return;
    const elapsed = Math.floor((Date.now() - state.startTime) / 1000);
    safeText(dom.elapsedTime, formatTime(elapsed));
}

// ---------- Render Active ----------
function renderPosture(p) {
    const statusMap = {
        good: { label: 'ท่าทางดี', klass: '' },
        warning: { label: 'ระวัง', klass: 'status-warn' },
        bad: { label: 'ท่าทางแย่', klass: 'status-bad' },
        paused: { label: '⏸ หยุดชั่วคราว', klass: 'status-idle' },
        no_person_detected: { label: 'ไม่เห็นคน', klass: 'status-idle' },
    };
    const m = statusMap[p.status] || statusMap.no_person_detected;
    safeClass(dom.statusCard, 'status-card ' + m.klass);
    safeText(dom.statusBadge, m.label);
    safeText(dom.statusMessage, p.message);

    safeText(dom.cvaValue, p.cva_angle != null ? p.cva_angle.toFixed(1) : '—');
    safeText(dom.hunchedValue, p.kyphosis_score != null ? p.kyphosis_score.toFixed(1) : '—');
}

function renderActiveStats(s) {
    safeText(dom.goodTime, formatTime(s.good_posture_seconds));
    safeText(dom.warningTime, formatTime(s.warning_posture_seconds));
    safeText(dom.badTime, formatTime(s.bad_posture_seconds));
    safeText(dom.alertCount, `${s.alert_count} ครั้ง`);
}

function showAlertToast(message) {
    const now = Date.now();
    if (now < state.alertShownUntil) return;
    safeText(dom.alertText, message);
    safeHidden(dom.alertToast, false);
    state.alertShownUntil = now + 3000;
    setTimeout(() => { safeHidden(dom.alertToast, true); }, 3000);
}

// ============================================================
// ===== Summary Page (rich) ==================================
// ============================================================

async function showSummary(summary, logs, sessionId) {
    safeHidden(dom.activeSession, true);
    safeHidden(dom.summaryPanel, false);
    safeHidden(dom.setupPanel, true);
    safeHidden(dom.historyPanel, true);

    const total = summary.actual_duration_seconds || 0;
    const good = summary.good_posture_seconds || 0;
    const warn = summary.warning_posture_seconds || 0;
    const bad = summary.bad_posture_seconds || 0;
    const alerts = summary.alert_count || 0;

    // ========= Score 0-100 =========
    // - หลักจาก ratio ของท่าดี (ถ่วงน้ำหนัก)
    // - ลบคะแนนจาก alerts มาก ๆ
    const sumTime = good + warn + bad;
    let score = 0;
    if (sumTime > 0) {
        const goodRatio = good / sumTime;
        const warnRatio = warn / sumTime;
        // good = full credit, warn = half credit, bad = 0
        score = (goodRatio * 100) + (warnRatio * 50);
    }
    // หัก 2 คะแนนต่อ alert (max หัก 30)
    score -= Math.min(alerts * 2, 30);
    score = Math.max(0, Math.min(100, Math.round(score)));

    renderHeroScore(score);

    // ========= Date =========
    safeText(dom.summaryDate, new Date().toLocaleString('th-TH', {
        year: 'numeric', month: 'long', day: 'numeric',
        hour: '2-digit', minute: '2-digit',
    }));

    // ========= Donut Chart =========
    renderDonut(good, warn, bad);

    // ========= Time Breakdown =========
    safeText(dom.sumDuration, formatTime(total));
    safeText(dom.sumGood, formatTime(good));
    safeText(dom.sumWarn, formatTime(warn));
    safeText(dom.sumBad, formatTime(bad));
    safeText(dom.sumAlerts, `${alerts} ครั้ง`);

    if (sumTime > 0) {
        safeText(dom.sumGoodPct, `${((good / sumTime) * 100).toFixed(0)}%`);
        safeText(dom.sumWarnPct, `${((warn / sumTime) * 100).toFixed(0)}%`);
        safeText(dom.sumBadPct, `${((bad / sumTime) * 100).toFixed(0)}%`);
    } else {
        safeText(dom.sumGoodPct, '—');
        safeText(dom.sumWarnPct, '—');
        safeText(dom.sumBadPct, '—');
    }

    const riskMap = {
        low:    { label: 'ต่ำ',     klass: 'risk-low' },
        medium: { label: 'ปานกลาง', klass: 'risk-medium' },
        high:   { label: 'สูง',     klass: 'risk-high' },
    };
    const risk = riskMap[summary.risk_level] || riskMap.low;
    safeText(dom.sumRisk, risk.label);
    safeClass(dom.riskCardSummary, 'breakdown-card ' + risk.klass);

    // ========= Issue Breakdown =========
    let fwdCount = 0, hunchedCount = 0;
    logs.forEach(l => {
        const t = (l.issue_type || '').toLowerCase();
        if (t.includes('forward_head')) fwdCount++;
        if (t.includes('hunched')) hunchedCount++;
    });
    const totalIssues = fwdCount + hunchedCount;

    safeText(dom.forwardHeadCount, `${fwdCount} ครั้ง`);
    safeText(dom.hunchedCount, `${hunchedCount} ครั้ง`);

    if (totalIssues > 0) {
        safeStyle(dom.forwardHeadFill, "width", `${(fwdCount / totalIssues) * 100}%`);
        safeStyle(dom.hunchedFill, "width", `${(hunchedCount / totalIssues) * 100}%`);
        if (fwdCount > hunchedCount) {
            safeText(dom.issueNote, 'พบปัญหาคอยื่นบ่อยกว่า ลองยกระดับหน้าจอให้สูงขึ้นเสมอระดับสายตา');
        } else if (hunchedCount > fwdCount) {
            safeText(dom.issueNote, 'พบปัญหาหลังคร่อมบ่อยกว่า ลองนั่งให้ก้นชิดพนักและพิงหลังตรง');
        } else {
            safeText(dom.issueNote, 'พบปัญหาทั้งสองแบบในจำนวนใกล้เคียงกัน ควรปรับท่านั่งโดยรวม');
        }
    } else {
        safeStyle(dom.forwardHeadFill, "width", '0%');
        safeStyle(dom.hunchedFill, "width", '0%');
        safeText(dom.issueNote, '🎉 ไม่พบปัญหาท่าทางใน Session นี้');
    }

    // ========= Compare with last =========
    renderCompare(summary, sessionId);

    // ========= Recommendations =========
    renderRecommendations(score, summary, fwdCount, hunchedCount, sumTime);

    // เก็บ snapshot สำหรับ session ถัดไป
    state.lastSummary = {
        score, good, warn, bad, alerts, sumTime,
    };
}

function renderHeroScore(score) {
    safeText(dom.scoreValue, score);
    // วงกลม progress (circumference = 2π × 52 ≈ 326.7)
    const circ = 326.7;
    const offset = circ - (score / 100) * circ;
    safeStyle(dom.scoreCircleFg, "strokeDashoffset", offset);

    let emoji, grade, msg, color;
    if (score >= 85) {
        emoji = '😎'; grade = 'ยอดเยี่ยม'; color = '#1D9E75';
        msg = 'ท่าทางการนั่งของคุณยอดเยี่ยม รักษาไว้ต่อไป';
    } else if (score >= 70) {
        emoji = '🙂'; grade = 'ดี'; color = '#3B9F2F';
        msg = 'ท่าทางการนั่งของคุณดี ยังมีจุดให้ปรับปรุงเล็กน้อย';
    } else if (score >= 50) {
        emoji = '😐'; grade = 'พอใช้'; color = '#D4A017';
        msg = 'ท่าทางอยู่ในเกณฑ์ปานกลาง ลองปรับท่านั่งให้ตรงขึ้น';
    } else if (score >= 30) {
        emoji = '😟'; grade = 'ต้องปรับปรุง'; color = '#D4581F';
        msg = 'ควรเริ่มใส่ใจท่านั่งของคุณ ก่อนเกิดอาการ Office Syndrome';
    } else {
        emoji = '😣'; grade = 'แย่'; color = '#C73E3E';
        msg = 'ท่านั่งไม่ดีมาก กรุณาพักและปรับท่านั่งทันที';
    }

    safeText(dom.scoreEmoji, emoji);
    safeText(dom.scoreGrade, grade);
    safeText(dom.scoreMessage, msg);
    safeStyle(dom.scoreCircleFg, "stroke", color);
    safeStyle(dom.scoreValue, "color", color);
}

function renderDonut(good, warn, bad) {
    const total = good + warn + bad;
    if (total === 0) {
        safeStyle(dom.donutGood, "strokeDasharray", '0 999');
        safeStyle(dom.donutWarn, "strokeDasharray", '0 999');
        safeStyle(dom.donutBad, "strokeDasharray", '0 999');
        safeText(dom.donutCenter, '—');
        safeText(dom.legendGood, '—');
        safeText(dom.legendWarn, '—');
        safeText(dom.legendBad, '—');
        return;
    }

    // circumference = 2π × 70 ≈ 439.8
    const C = 439.8;
    const goodLen = (good / total) * C;
    const warnLen = (warn / total) * C;
    const badLen  = (bad  / total) * C;

    safeStyle(dom.donutGood, "strokeDasharray", `${goodLen} ${C - goodLen}`);
    safeStyle(dom.donutGood, "strokeDashoffset", '0');

    safeStyle(dom.donutWarn, "strokeDasharray", `${warnLen} ${C - warnLen}`);
    safeStyle(dom.donutWarn, "strokeDashoffset", `-${goodLen}`);

    safeStyle(dom.donutBad, "strokeDasharray", `${badLen} ${C - badLen}`);
    safeStyle(dom.donutBad, "strokeDashoffset", `-${goodLen + warnLen}`);

    safeText(dom.donutCenter, `${((good / total) * 100).toFixed(0)}%`);
    safeText(dom.legendGood, formatTime(good));
    safeText(dom.legendWarn, formatTime(warn));
    safeText(dom.legendBad, formatTime(bad));
}

function renderCompare(summary, currentId) {
    // หา session ก่อนหน้านี้ (id น้อยกว่า currentId ที่จบแล้ว)
    const prevSessions = state.cachedSessions
        .filter(s => s.end_time !== null && s.id !== currentId)
        .sort((a, b) => b.id - a.id);

    if (prevSessions.length === 0) {
        safeHidden(dom.compareCard, true);
        return;
    }

    const prev = prevSessions[0];
    const prevTotal = (prev.good_seconds || 0) + (prev.warning_seconds || 0) + (prev.bad_seconds || 0);
    if (prevTotal === 0) {
        safeHidden(dom.compareCard, true);
        return;
    }

    const curTotal = (summary.good_posture_seconds || 0) + (summary.warning_posture_seconds || 0) + (summary.bad_posture_seconds || 0);
    if (curTotal === 0) {
        safeHidden(dom.compareCard, true);
        return;
    }

    const prevGoodPct = (prev.good_seconds / prevTotal) * 100;
    const curGoodPct = (summary.good_posture_seconds / curTotal) * 100;
    const goodDiff = curGoodPct - prevGoodPct;

    const prevAlerts = prev.alert_count || 0;
    const curAlerts = summary.alert_count || 0;
    const alertDiff = curAlerts - prevAlerts;

    safeHidden(dom.compareCard, false);

    // % good
    if (Math.abs(goodDiff) < 1) {
        safeText(dom.cmpGoodArrow, '➡');
        safeClass(dom.cmpGoodArrow, 'compare-arrow same');
        safeText(dom.cmpGoodText, 'เท่าเดิม');
    } else if (goodDiff > 0) {
        safeText(dom.cmpGoodArrow, '↑');
        safeClass(dom.cmpGoodArrow, 'compare-arrow up-good');
        safeText(dom.cmpGoodText, `ดีขึ้น ${goodDiff.toFixed(1)}%`);
    } else {
        safeText(dom.cmpGoodArrow, '↓');
        safeClass(dom.cmpGoodArrow, 'compare-arrow down-bad');
        safeText(dom.cmpGoodText, `ลดลง ${Math.abs(goodDiff).toFixed(1)}%`);
    }

    // alerts
    if (alertDiff === 0) {
        safeText(dom.cmpAlertArrow, '➡');
        safeClass(dom.cmpAlertArrow, 'compare-arrow same');
        safeText(dom.cmpAlertText, 'เท่าเดิม');
    } else if (alertDiff < 0) {
        safeText(dom.cmpAlertArrow, '↓');
        safeClass(dom.cmpAlertArrow, 'compare-arrow up-good');
        safeText(dom.cmpAlertText, `ลดลง ${Math.abs(alertDiff)} ครั้ง`);
    } else {
        safeText(dom.cmpAlertArrow, '↑');
        safeClass(dom.cmpAlertArrow, 'compare-arrow down-bad');
        safeText(dom.cmpAlertText, `เพิ่มขึ้น ${alertDiff} ครั้ง`);
    }
}

function renderRecommendations(score, summary, fwdCount, hunchedCount, sumTime) {
    const recs = [];

    if (sumTime === 0) {
        recs.push('ไม่มีข้อมูลเพียงพอ — Session นี้สั้นเกินไป');
        renderRecList(recs);
        return;
    }

    const goodPct = (summary.good_posture_seconds / sumTime) * 100;
    const badPct = (summary.bad_posture_seconds / sumTime) * 100;

    // คำแนะนำตามคะแนน
    if (score >= 85) {
        recs.push('ท่าทางการนั่งของคุณยอดเยี่ยมมาก รักษาไว้ต่อไป');
    } else if (score >= 70) {
        recs.push('ท่าทางการนั่งดี ลองพักและยืดเหยียดทุก 30-45 นาทีเพื่อรักษาระดับนี้');
    } else if (score >= 50) {
        recs.push('ปรับท่านั่งให้ตรงขึ้น โดยเฉพาะระหว่างที่จดจ่อกับงาน');
    } else {
        recs.push('คะแนนของคุณต่ำกว่าเกณฑ์ — ควรปรับท่านั่งใหม่ทันทีก่อนเกิดอาการเรื้อรัง');
    }

    // คำแนะนำเฉพาะปัญหา
    if (fwdCount > hunchedCount && fwdCount > 0) {
        recs.push('คอยื่นบ่อย — ยกหน้าจอให้ขอบบนอยู่ระดับสายตา และเลื่อนเก้าอี้ให้ใกล้โต๊ะมากขึ้น');
    }
    if (hunchedCount > fwdCount && hunchedCount > 0) {
        recs.push('หลังคร่อมบ่อย — ใช้พนักรองหลังหรือหมอนรองเอว และนั่งโดยให้สะโพกชิดพนักเก้าอี้');
    }
    if (fwdCount > 0 && hunchedCount > 0) {
        recs.push('ลองทำท่ายืดเหยียดต้นคอและไหล่ระหว่างพักงานทุก 1 ชั่วโมง');
    }

    // คำแนะนำตาม alerts
    if ((summary.alert_count || 0) >= 5) {
        recs.push('มีการแจ้งเตือนค่อนข้างถี่ในรอบนี้ — ลองพักจากหน้าจอสัก 5 นาที');
    }

    // คำแนะนำตามระยะเวลา
    if (sumTime >= 60 * 60) {
        recs.push('นั่งนานกว่า 1 ชั่วโมง ควรลุกเดินและดื่มน้ำเพื่อสุขภาพดวงตาและกล้ามเนื้อ');
    }

    if (badPct < 5) {
        recs.push('🎉 รอบนี้ผ่านไปด้วยดี ขอชื่นชมในความใส่ใจสุขภาพของคุณ');
    }

    renderRecList(recs);
}

function renderRecList(recs) {
    safeHTML(dom.recList, recs.map(r => `<li>${r}</li>`).join(''));
}

// ============================================================
// ===== History Page (rich) ==================================
// ============================================================

function showSetupPanel() {
    safeHidden(dom.summaryPanel, true);
    safeHidden(dom.historyPanel, false);
    safeHidden(dom.setupPanel, false);
    safeHidden(dom.activeSession, true);
}

async function loadHistory() {
    try {
        const { sessions } = await api.getHistory(state.user.id, 50);
        state.cachedSessions = sessions || [];
        renderHistory(state.cachedSessions);
    } catch (err) {
        console.error('load history failed:', err);
    }
}

function renderHistory(sessions) {
    const completed = (sessions || []).filter(s => s.end_time !== null);

    if (completed.length === 0) {
        safeHTML(dom.historyList, '<p class="empty-state">ยังไม่มีประวัติ</p>');
        safeHidden(dom.historyStats, true);
        safeHidden(dom.trendCard, true);
        return;
    }

    // ===== Aggregate stats =====
    let totalSec = 0, totalGood = 0, totalAlerts = 0;
    completed.forEach(s => {
        const sec = (s.good_seconds || 0) + (s.warning_seconds || 0) + (s.bad_seconds || 0);
        totalSec += sec;
        totalGood += s.good_seconds || 0;
        totalAlerts += s.alert_count || 0;
    });
    const avgGoodPct = totalSec > 0 ? (totalGood / totalSec) * 100 : 0;

    safeHidden(dom.historyStats, false);
    safeText(dom.histTotalSessions, `${completed.length} ครั้ง`);
    safeText(dom.histTotalTime, formatLongTime(totalSec));
    safeText(dom.histAvgGood, `${avgGoodPct.toFixed(0)}%`);
    safeText(dom.histTotalAlerts, `${totalAlerts} ครั้ง`);

    // ===== Trend chart 7 ครั้งล่าสุด =====
    renderTrend(completed.slice(0, 7).reverse());

    // ===== Session cards =====
    const riskMap = {
        low:    { label: 'LOW',    klass: 'risk-low' },
        medium: { label: 'MEDIUM', klass: 'risk-medium' },
        high:   { label: 'HIGH',   klass: 'risk-high' },
    };

    safeHTML(dom.historyList, completed.map(s => {
        const date = new Date(s.start_time + 'Z');
        const dateStr = date.toLocaleString('th-TH', {
            year: 'numeric', month: 'short', day: 'numeric',
            hour: '2-digit', minute: '2-digit',
        });

        const sec = (s.good_seconds || 0) + (s.warning_seconds || 0) + (s.bad_seconds || 0);
        const goodPct = sec > 0 ? (s.good_seconds / sec) * 100 : 0;
        const warnPct = sec > 0 ? (s.warning_seconds / sec) * 100 : 0;
        const badPct = sec > 0 ? (s.bad_seconds / sec) * 100 : 0;

        const risk = riskMap[s.risk_level] || riskMap.low;

        return `
            <div class="history-card">
                <div class="hcard-row">
                    <div class="hcard-date">
                        <span class="hcard-date-main">${dateStr}</span>
                        <span class="hcard-duration">${formatTime(sec)}
                            ${s.planned_duration_min ? `<span class="hcard-planned">/ ${s.planned_duration_min} นาที</span>` : ''}
                        </span>
                    </div>
                    <span class="history-risk-badge ${risk.klass}">${risk.label}</span>
                </div>

                <div class="hcard-bar">
                    <div class="hcard-bar-good" style="width:${goodPct}%" title="ดี ${formatTime(s.good_seconds)}"></div>
                    <div class="hcard-bar-warn" style="width:${warnPct}%" title="เตือน ${formatTime(s.warning_seconds)}"></div>
                    <div class="hcard-bar-bad" style="width:${badPct}%" title="แย่ ${formatTime(s.bad_seconds)}"></div>
                </div>

                <div class="hcard-stats">
                    <span><span class="dot-good"></span> ดี ${goodPct.toFixed(0)}%</span>
                    <span><span class="dot-warn"></span> เตือน ${warnPct.toFixed(0)}%</span>
                    <span><span class="dot-bad"></span> แย่ ${badPct.toFixed(0)}%</span>
                    <span class="hcard-alerts">🔔 ${s.alert_count || 0}</span>
                </div>
            </div>
        `;
    }).join(''));
}

function renderTrend(sessions) {
    if (sessions.length < 2) {
        safeHidden(dom.trendCard, true);
        return;
    }

    safeHidden(dom.trendCard, false);

    const W = 600, H = 180;
    const padX = 40, padY = 30;
    const innerW = W - padX * 2;
    const innerH = H - padY * 2;

    const points = sessions.map(s => {
        const sec = (s.good_seconds || 0) + (s.warning_seconds || 0) + (s.bad_seconds || 0);
        return sec > 0 ? (s.good_seconds / sec) * 100 : 0;
    });

    const stepX = innerW / (points.length - 1);

    // y: 0% ที่ bottom, 100% ที่ top
    const toY = (pct) => padY + innerH - (pct / 100) * innerH;

    let svg = '';

    // Grid lines + labels
    [0, 25, 50, 75, 100].forEach(p => {
        const y = toY(p);
        svg += `<line x1="${padX}" y1="${y}" x2="${W - padX}" y2="${y}" stroke="#E5E5E0" stroke-width="0.5"/>`;
        svg += `<text x="${padX - 8}" y="${y + 3}" text-anchor="end" font-size="10" fill="#888780">${p}%</text>`;
    });

    // Path
    const pathPoints = points.map((p, i) => `${padX + i * stepX},${toY(p)}`).join(' L ');
    svg += `<path d="M ${pathPoints}" fill="none" stroke="#1D9E75" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>`;

    // Area under
    const areaPoints = `M ${padX},${toY(0)} L ${pathPoints} L ${padX + (points.length - 1) * stepX},${toY(0)} Z`;
    svg = `<path d="${areaPoints}" fill="#1D9E75" opacity="0.1"/>` + svg;

    // Dots + labels
    points.forEach((p, i) => {
        const x = padX + i * stepX;
        const y = toY(p);
        svg += `<circle cx="${x}" cy="${y}" r="4" fill="#1D9E75"/>`;
        svg += `<text x="${x}" y="${y - 10}" text-anchor="middle" font-size="10" fill="#1D9E75" font-weight="600">${p.toFixed(0)}%</text>`;
        // x-axis label (วันที่)
        const date = new Date(sessions[i].start_time + 'Z');
        const dateStr = date.toLocaleDateString('th-TH', { month: 'short', day: 'numeric' });
        svg += `<text x="${x}" y="${H - padY + 16}" text-anchor="middle" font-size="9" fill="#888780">${dateStr}</text>`;
    });

    safeHTML(dom.trendSvg, svg);
}

// ---------- Utils ----------
function formatTime(totalSeconds) {
    const s = Math.floor(totalSeconds || 0);
    const mm = String(Math.floor(s / 60)).padStart(2, '0');
    const ss = String(s % 60).padStart(2, '0');
    return `${mm}:${ss}`;
}

function formatLongTime(totalSeconds) {
    const s = Math.floor(totalSeconds || 0);
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    if (h > 0) return `${h} ชม. ${m} นาที`;
    return `${m} นาที`;
}