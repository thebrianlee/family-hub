// Fit the kiosk layout to smaller screens.
//
// The app is laid out for a large wall screen: about 1080 px wide and 600 px
// tall at the least (a 1080x1920 portrait monitor, a 1024x600 panel, a TV).
// On a smaller kiosk screen, such as the Raspberry Pi Touch Display 2
// (720x1280) or the old 7" panel (800x480), the same layout is shown scaled
// down to fit, so nothing overlaps or runs off the edge. Phones (narrower than
// 640 px, Tailwind's max-sm) are not scaled: they get their own CSS, keyed on
// data-phone.
//
// It runs before the first paint (an inline script in <head>), and again on
// every resize or rotation. --fit is used by html { zoom }, .screen-fit and
// .touch-target. Because it sets attributes on <html> before React hydrates,
// every <html> in app/layout.tsx carries suppressHydrationWarning.
export const FIT_SCRIPT = `(function(){
  function fit(){
    var w = window.innerWidth, h = window.innerHeight, phone = w < 640;
    var z = phone ? 1 : Math.max(0.5, Math.min(1, w / 1080, h / 600));
    var r = document.documentElement;
    r.style.setProperty("--fit", String(z));
    r.dataset.phone = phone ? "1" : "0";
  }
  fit();
  window.addEventListener("resize", fit);
})();`;
