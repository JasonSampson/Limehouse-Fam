// LimeHQ is the only real front door — this page should never be a place
// someone actually stops and reads. Whatever brought them here (an expired
// session, a stray bookmark, a direct link), just bounce them straight back
// to LimeHQ immediately. replace() (not href=) so this hop doesn't leave a
// dead entry in browser history that the back button could land on.
// The button and markup on this page still exist as a plain-HTML fallback
// for the rare case JS doesn't run — that's the only reason this file
// doesn't just delete the whole page.
window.location.replace("/auth/login");
