const params = new URLSearchParams(window.location.search);
if (params.get("reason") === "expired") {
  document.getElementById("reason-banner").innerHTML =
    '<div class="alert alert-warn">Your session expired. Please sign in again.</div>';
}
