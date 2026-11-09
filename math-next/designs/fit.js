// Mockup helper: the page is drawn at 1920x1080 and this shrinks (or grows)
// it to fit the window, centered, the same way ?screen= does on /math-next/.
(function () {
  function fit() {
    var frame = document.querySelector('.frame');
    var scale = Math.min(window.innerWidth / 1920, window.innerHeight / 1080);
    var left = (window.innerWidth - 1920 * scale) / 2;
    var top = (window.innerHeight - 1080 * scale) / 2;
    frame.style.transform = 'translate(' + left + 'px,' + top + 'px) scale(' + scale + ')';
  }
  window.addEventListener('resize', fit);
  fit();

  // Inside the picker page's thumbnails, hide the "which design" tag.
  if (window.self !== window.top) {
    var tag = document.querySelector('.mock-tag');
    if (tag) tag.hidden = true;
  }
})();
