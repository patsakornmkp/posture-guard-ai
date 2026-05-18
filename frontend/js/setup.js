let plannedMinutes = null;

document.addEventListener('DOMContentLoaded', () => {
    const user = utils.requireAuth();
    if (!user) return;

    const durationGroup = document.getElementById('durationGroup');
    const startBtn = document.getElementById('startBtn');

    if (!durationGroup || !startBtn) {
        console.error('setup.js: durationGroup หรือ startBtn ไม่พบในหน้า setup.html');
        return;
    }

    localStorage.removeItem('plannedMinutes');

    plannedMinutes = null;
    startBtn.disabled = false;
    startBtn.classList.add('is-waiting');
    startBtn.textContent = 'กรุณาเลือกเวลาก่อน';

    durationGroup.addEventListener('click', (e) => {
        const btn = e.target.closest('.duration-btn');
        if (!btn) return;

        document.querySelectorAll('.duration-btn').forEach((b) => {
            b.classList.remove('active');
        });

        btn.classList.add('active');
        plannedMinutes = Number(btn.dataset.minutes);

        startBtn.disabled = false;
        startBtn.classList.remove('is-waiting');
        startBtn.textContent = '▶ เริ่มการใช้งาน';
    });

    startBtn.addEventListener('click', async () => {
        if (plannedMinutes === null || Number.isNaN(plannedMinutes)) {
            alert('กรุณาเลือกระยะเวลาก่อนเริ่มใช้งาน');
            return;
        }

        startBtn.disabled = true;
        startBtn.textContent = 'กำลังเริ่ม...';

        try {
            try {
                await api.stopSession();
            } catch (_) {}

            try {
                await api.stopCamera();
            } catch (_) {}

            await api.startCamera();

            const result = await api.startSession(user.id, plannedMinutes);

            localStorage.setItem('currentSessionId', result.session_id);
            localStorage.setItem('plannedMinutes', String(plannedMinutes));

            window.location.href = 'monitoring.html';
        } catch (err) {
            alert('ไม่สามารถเริ่ม session ได้: ' + err.message);

            startBtn.disabled = false;
            startBtn.textContent = '▶ เริ่มการใช้งาน';
        }
    });
});