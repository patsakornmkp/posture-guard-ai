/* =========================================
   Login Page
   File: frontend/js/login.js

   Fix Part 9:
   - ผูก event submit ทันที ไม่รอ async session guard ก่อน
   - ลดโอกาสกดปุ่มแล้วไม่มีอะไรเกิดขึ้น
   - login สำเร็จแล้วไป setup.html โดยตรง
   - เคลียร์ session flow เก่าที่ค้างใน localStorage ก่อนเริ่มใหม่
========================================= */

(function () {
    "use strict";

    document.addEventListener("DOMContentLoaded", () => {
        const loginForm = document.getElementById("loginForm");
        const usernameInput = document.getElementById("username");
        const passwordInput = document.getElementById("password");
        const msg = document.getElementById("message");
        const submitBtn = document.getElementById("submitBtn");

        if (!loginForm || !usernameInput || !passwordInput || !msg || !submitBtn) {
            console.error("login.js: login form elements ไม่ครบ");
            return;
        }

        if (!window.api || !window.utils) {
            showMessage("ระบบ frontend โหลดไม่ครบ กรุณาตรวจสอบว่า app.js โหลดสำเร็จ", "error");
            submitBtn.disabled = true;
            return;
        }

        let isSubmitting = false;
        const defaultButtonText = submitBtn.textContent || "เข้าสู่ระบบ";

        loginForm.addEventListener("submit", async (event) => {
            event.preventDefault();

            if (isSubmitting) {
                return;
            }

            const username = usernameInput.value.trim();
            const password = passwordInput.value;

            const validationMessage = validateLoginForm(username, password);
            if (validationMessage) {
                showMessage(validationMessage, "error");
                focusInvalidInput(username, password);
                return;
            }

            isSubmitting = true;
            setFormLoading(true, "กำลังเข้าสู่ระบบ...");

            try {
                const user = await api.login(username, password);

                if (!user || !user.id) {
                    throw new Error("ข้อมูลผู้ใช้จาก backend ไม่ถูกต้อง");
                }

                // เก็บ user ล่าสุด และล้าง state session เก่าที่อาจค้างจากรอบก่อน
                localStorage.setItem("currentUser", JSON.stringify(user));

                if (utils.clearSessionFlowState) {
                    utils.clearSessionFlowState({ keepLast: false });
                }

                showMessage("เข้าสู่ระบบสำเร็จ กำลังไปหน้าเริ่มใช้งาน...", "success");

                window.location.replace("setup.html");
            } catch (err) {
                console.error("Login failed:", err);

                showMessage(
                    err.message || "เข้าสู่ระบบไม่สำเร็จ กรุณาลองอีกครั้ง",
                    "error"
                );

                isSubmitting = false;
                setFormLoading(false);
            }
        });

        function validateLoginForm(username, password) {
            if (!username) {
                return "กรุณากรอก Username";
            }

            if (!password) {
                return "กรุณากรอก Password";
            }

            return "";
        }

        function focusInvalidInput(username, password) {
            if (!username) {
                usernameInput.focus();
                return;
            }

            if (!password) {
                passwordInput.focus();
            }
        }

        function showMessage(text, type = "error") {
            msg.hidden = false;
            msg.textContent = text;

            msg.classList.remove("success", "error");

            if (type === "success") {
                msg.classList.add("success");
            } else {
                msg.classList.add("error");
            }
        }

        function hideMessage() {
            msg.hidden = true;
            msg.textContent = "";
            msg.classList.remove("success", "error");
        }

        function setFormLoading(isLoading, loadingText = "กำลังเข้าสู่ระบบ...") {
            submitBtn.disabled = isLoading;
            submitBtn.textContent = isLoading ? loadingText : defaultButtonText;

            usernameInput.disabled = isLoading;
            passwordInput.disabled = isLoading;

            if (isLoading) {
                hideMessage();
            }
        }
    });
})();
