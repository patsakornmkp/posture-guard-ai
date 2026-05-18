document.getElementById('loginForm').addEventListener('submit', async (e) => {
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
        window.location.href = 'setup.html';
    } catch (err) {
        msg.hidden = false;
        msg.textContent = err.message || 'เข้าสู่ระบบไม่สำเร็จ';
        btn.disabled = false;
        btn.textContent = 'เข้าสู่ระบบ';
    }
});