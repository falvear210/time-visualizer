// Preview mode for the editor pages when they're opened anywhere other than
// the local editor server (python3 editor/server.py on this computer).
//
// The deployed copy on sluhtime.alvear.cl is only for showing coworkers how
// the editor works: the web server can't save, and it shouldn't let anyone
// on the internet change what the TVs show. So off localhost this:
//   - hides the Save and "Get latest calendar" buttons,
//   - shows a banner explaining that changes aren't saved,
//   - turns off the "you have unsaved changes" prompt when leaving.
// Loaded in <head>, before the page's own scripts, so its beforeunload
// listener runs first and can stop theirs.
(function () {
  var local = ["localhost", "127.0.0.1", "[::1]", ""].indexOf(location.hostname) !== -1;
  if (local) return;

  document.documentElement.classList.add("ed-preview");

  window.addEventListener("beforeunload", function (e) {
    e.stopImmediatePropagation(); // nothing can be saved here, so don't warn
  });

  document.addEventListener("DOMContentLoaded", function () {
    var main = document.querySelector(".ed-main");
    if (!main) return;
    var note = document.createElement("div");
    note.className = "ed-note ed-preview-note";
    note.innerHTML = "<strong>Preview only.</strong> Try anything you like: nothing here is saved, " +
      "and the TVs won't change. Tell Fernando what you'd set differently.";
    main.insertBefore(note, main.firstChild);
  });
})();
