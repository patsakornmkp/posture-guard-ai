/* =========================================
   Register Page
   File: frontend/js/register.js

   UX minimal-change:
   1) กันผู้ใช้ที่ login แล้วกลับมาหน้า register
   2) กัน submit ซ้ำ
   3) ตรวจ input เบื้องต้นก่อนเรียก backend
   4) แสดง loading/error ใน message เดิม
   5) สมัครสำเร็จแล้ว redirect ด้วย replace
========================================= */

(function () {
    "use strict";

    document.addEventListener("DOMContentLoaded", async () => {
        if (!window.api || !window.utils) {
            alert("ระบบ frontend โหลดไม่ครบ กรุณาตรวจสอบการเรียกไฟล์ app.js");
            window.location.replace("login.html");
            return;
        }

        const canStayOnRegister = await utils.redirectAuthenticatedAwayFromAuthPage();

        if (!canStayOnRegister) {
            return;
        }

        const registerForm = document.getElementById("registerForm");
        const fullNameInput = document.getElementById("fullName");
        const usernameInput = document.getElementById("username");
        const passwordInput = document.getElementById("password");
        const msg = document.getElementById("message");
        const submitBtn = document.getElementById("submitBtn");

        if (!registerForm || !usernameInput || !passwordInput || !msg || !submitBtn) {
            console.error("register.js: register form elements ไม่ครบ");
            return;
        }

        let isSubmitting = false;
        const defaultButtonText = submitBtn.textContent || "สมัครสมาชิก";

        registerForm.addEventListener("submit", async (event) => {
            event.preventDefault();

            if (isSubmitting) {
                return;
            }

            const fullName = fullNameInput ? fullNameInput.value.trim() : "";
            const username = usernameInput.value.trim();
            const password = passwordInput.value;

            const validationMessage = validateRegisterForm(username, password);

            if (validationMessage) {
                showMessage(validationMessage, "error");
                focusInvalidInput(username, password);
                return;
            }

            isSubmitting = true;
            setFormLoading(true, "กำลังสมัคร...");

            try {
                await api.register(username, password, fullName);

                showMessage(
                    "สมัครสมาชิกสำเร็จ กำลังไปหน้าเข้าสู่ระบบ...",
                    "success"
                );

                window.setTimeout(() => {
                    window.location.replace("login.html");
                }, 900);
            } catch (err) {
                showMessage(
                    err.message || "สมัครสมาชิกไม่สำเร็จ กรุณาลองอีกครั้ง",
                    "error"
                );

                isSubmitting = false;
                setFormLoading(false);
            }
        });

        function validateRegisterForm(username, password) {
            if (!username) {
                return "กรุณากรอก Username";
            }

            if (username.length < 3) {
                return "Username ต้องมีอย่างน้อย 3 ตัวอักษร";
            }

            if (!password) {
                return "กรุณากรอก Password";
            }

            if (password.length < 4) {
                return "Password ต้องมีอย่างน้อย 4 ตัวอักษร";
            }

            return "";
        }

        function focusInvalidInput(username, password) {
            if (!username || username.length < 3) {
                usernameInput.focus();
                return;
            }

            if (!password || password.length < 4) {
                passwordInput.focus();
            }
        }

        function showMessage(text, type = "error") {
            msg.hidden = false;
            msg.textContent = text;

            if (type === "success") {
                msg.classList.add("success");
            } else {
                msg.classList.remove("success");
            }
        }

        function hideMessage() {
            msg.hidden = true;
            msg.textContent = "";
            msg.classList.remove("success");
        }

        function setFormLoading(isLoading, loadingText = "กำลังสมัคร...") {
            submitBtn.disabled = isLoading;
            submitBtn.textContent = isLoading ? loadingText : defaultButtonText;

            usernameInput.disabled = isLoading;
            passwordInput.disabled = isLoading;

            if (fullNameInput) {
                fullNameInput.disabled = isLoading;
            }

            if (isLoading) {
                hideMessage();
            }
        }
    });
})();