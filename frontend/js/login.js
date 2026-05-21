document.addEventListener('DOMContentLoaded', () => {
    utils.redirectAuthenticatedAwayFromAuthPage();

    const loginForm = document.getElementById('loginForm');

    if (!loginForm) {
        console.error('login.js: loginForm ไม่พบในหน้า login.html');
        return;
    }

    loginForm.addEventListener('submit', async (e) => {
        e.preventDefault();

        const username = document.getElementById('username').value.trim();
        const password = document.getElementById('password').value;
        const msg = document.getElementById('message');
        const btn = document.getElementById('submitBtn');

        msg.hidden = true;
        btn.disabled = true;
        btn.textContent = 'กำลังเข้าสู่ระบบ...';

        try {
            const user = await api.login(username, password);

            localStorage.setItem('currentUser', JSON.stringify(user));
            utils.clearSessionFlowState({ keepLast: false });

            // ใช้ replace เพื่อไม่ให้ browser back กลับมาหน้า login หลัง login สำเร็จ
            utils.redirectTo('setup.html', { replace: true });
        } catch (err) {
            msg.hidden = false;
            msg.textContent = err.message || 'เข้าสู่ระบบไม่สำเร็จ';
            btn.disabled = false;
            btn.textContent = 'เข้าสู่ระบบ';
        }
    });
});