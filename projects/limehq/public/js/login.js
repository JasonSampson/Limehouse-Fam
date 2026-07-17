const form = document.getElementById('login-form');
const submitBtn = document.getElementById('submit-btn');
const errorMsg = document.getElementById('error-msg');

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  errorMsg.style.display = 'none';
  submitBtn.disabled = true;
  submitBtn.textContent = 'Signing in…';

  try {
    const res = await fetch('/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({
        email: document.getElementById('email').value,
        password: document.getElementById('password').value,
      }),
    });

    const data = await res.json();

    if (res.ok && data.ok) {
      window.location.href = '/launcher';
    } else if (res.status === 429) {
      const secs = data.retryAfterSeconds ?? 900;
      const mins = Math.ceil(secs / 60);
      showError(`Too many failed attempts. Account locked for ${mins} minute(s).`);
    } else {
      showError(data.error ?? 'Invalid email or password');
    }
  } catch {
    showError('Network error — please try again.');
  } finally {
    submitBtn.disabled = false;
    submitBtn.textContent = 'Sign in';
  }
});

function showError(msg) {
  errorMsg.textContent = msg;
  errorMsg.style.display = 'block';
}
