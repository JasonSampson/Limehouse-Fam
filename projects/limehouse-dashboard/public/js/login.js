// Just shows a plain-language message if the callback route bounced back
// here with an error reason in the query string (e.g. ?error=unauthorized)
// — the actual sign-in click is a plain link to /auth/login, no fetch needed.
document.addEventListener("DOMContentLoaded", () => {
  const params = new URLSearchParams(window.location.search);
  const error = params.get("error");
  if (error) {
    document.getElementById("login-error").textContent =
      "Sign-in failed. Please try again or contact Jason.";
  }
});
