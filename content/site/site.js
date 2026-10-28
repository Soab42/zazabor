// Zazabor's product page: the library's live numbers, categories and soundtracks (from
// catalog.json, beside this page), the latest version (GitHub), copy buttons, the template
// strips and the reveal on scroll. Everything on the page reads fine without it.
(() => {
  const $ = (s, root = document) => root.querySelector(s);
  const $$ = (s, root = document) => [...root.querySelectorAll(s)];
  const CATEGORIES = {
    launch: "Product launch", sale: "Sale & offers", feature: "Feature highlight", app: "App & tech",
    review: "Testimonials", fashion: "Fashion & beauty", food: "Food & restaurant", estate: "Real estate",
    festive: "Festive", logo: "Logo reveals", lower: "Lower thirds", hook: "Reel hooks",
  };
  const PLAY = '<svg viewBox="0 0 24 24" class="i" aria-hidden="true"><path d="M8 5.5v13l11-6.5z"/></svg>';
  const PAUSE = '<svg viewBox="0 0 24 24" class="i" aria-hidden="true"><rect x="6.5" y="5" width="4" height="14" rx="1"/><rect x="13.5" y="5" width="4" height="14" rx="1"/></svg>';
  const time = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;

  // The nav turns to glass once the page scrolls.
  const nav = $(".nav");
  const onScroll = () => nav.classList.toggle("scrolled", scrollY > 8);
  addEventListener("scroll", onScroll, { passive: true });
  onScroll();

  // Copy buttons.
  for (const button of $$("[data-copy]")) {
    button.addEventListener("click", async () => {
      const text = document.getElementById(button.dataset.copy)?.textContent ?? "";
      try {
        await navigator.clipboard.writeText(text);
        button.classList.add("done");
        button.querySelector("span").textContent = "Copied";
        setTimeout(() => { button.classList.remove("done"); button.querySelector("span").textContent = "Copy"; }, 1800);
      } catch {
        getSelection().selectAllChildren(document.getElementById(button.dataset.copy));
      }
    });
  }

  // The template strips loop: each holds its cards twice.
  for (const strip of $$(".card-strip")) strip.append(...[...strip.children].map((n) => n.cloneNode(true)));

  // Sections fade in as they come into view.
  if ("IntersectionObserver" in window && !matchMedia("(prefers-reduced-motion: reduce)").matches) {
    const io = new IntersectionObserver((entries) => {
      for (const e of entries) if (e.isIntersecting) { e.target.classList.add("in"); io.unobserve(e.target); }
    }, { rootMargin: "0px 0px -8% 0px" });
    for (const el of $$(".section .wrap > *, .stats-grid, .tile, .feature, .track")) { el.classList.add("reveal"); io.observe(el); }
  }

  // The latest release.
  fetch("https://api.github.com/repos/Soab42/zazabor/releases/latest", { headers: { Accept: "application/vnd.github+json" } })
    .then((r) => (r.ok ? r.json() : null))
    .then((release) => {
      const v = release?.tag_name?.replace(/^v/, "");
      if (!v) return;
      for (const el of $$("[data-version]")) el.textContent = v.split(".").slice(0, 2).join(".");
      for (const el of $$("[data-version-label]")) el.textContent = ` · ${v}`;
    })
    .catch(() => {});

  // The library: its numbers, categories and soundtracks.
  fetch("catalog.json", { cache: "no-cache" })
    .then((r) => r.json())
    .then((catalog) => {
      const counts = { templates: catalog.templates.length, music: catalog.music.length, fonts: catalog.fonts.length };
      for (const el of $$("[data-stat]")) if (counts[el.dataset.stat] != null) el.textContent = counts[el.dataset.stat];

      const per = {};
      for (const t of catalog.templates) per[t.category] = (per[t.category] ?? 0) + 1;
      const cats = $("[data-categories]");
      if (cats) {
        cats.replaceChildren(...Object.entries(CATEGORIES).filter(([id]) => per[id]).map(([id, label]) => {
          const li = document.createElement("li");
          li.append(label, Object.assign(document.createElement("em"), { textContent: per[id] }));
          return li;
        }));
      }
      const updated = $("[data-updated]");
      if (updated && catalog.published) {
        const when = new Date(catalog.published * 1000).toLocaleDateString(undefined, { day: "numeric", month: "long", year: "numeric" });
        updated.textContent = `Last updated ${when}; new templates reach Zazabor within the hour.`;
      }
      tracks(catalog.music);
    })
    .catch(() => { $("[data-tracks]")?.replaceChildren(); });

  function tracks(list) {
    const ol = $("[data-tracks]");
    if (!ol) return;
    const audio = new Audio();
    audio.preload = "none";
    const canPlay = !!audio.canPlayType('audio/ogg; codecs="vorbis"');
    let current = null;
    const rows = list.map((t) => {
      const li = document.createElement("li");
      li.className = "track";
      // Fixed markup only; the catalog's text goes in as text.
      li.innerHTML = `<button class="play" type="button">${PLAY}</button>
        <div><div class="track-title"></div><div class="track-vibe"></div></div>
        <span class="bpm"></span><span class="dur"></span><span class="bar"></span>`;
      $(".track-title", li).append(t.title, Object.assign(document.createElement("span"), { className: "eq", innerHTML: "<i></i><i></i><i></i>" }));
      $(".track-vibe", li).textContent = t.vibe;
      $(".bpm", li).textContent = `${Math.round(Number(t.bpm) || 0)} BPM`;
      $(".dur", li).textContent = time(Number(t.seconds) || 0);
      const button = $(".play", li);
      button.setAttribute("aria-label", `Play ${t.title}`);
      button.disabled = !canPlay;
      button.addEventListener("click", () => {
        if (current === li && !audio.paused) return audio.pause();
        if (current !== li) {
          current?.classList.remove("playing");
          rows.forEach((r) => { $(".play", r).innerHTML = PLAY; $(".bar", r).style.width = "0"; });
          audio.src = t.file;
          current = li;
        }
        audio.play().catch(() => {});
      });
      return li;
    });
    const sync = (playing) => {
      if (!current) return;
      current.classList.toggle("playing", playing);
      $(".play", current).innerHTML = playing ? PAUSE : PLAY;
      $(".play", current).setAttribute("aria-label", `${playing ? "Pause" : "Play"} ${$(".track-title", current).firstChild.textContent}`);
    };
    audio.addEventListener("play", () => sync(true));
    audio.addEventListener("pause", () => sync(false));
    audio.addEventListener("ended", () => sync(false));
    audio.addEventListener("timeupdate", () => {
      if (current && audio.duration) $(".bar", current).style.width = `${(audio.currentTime / audio.duration) * 100}%`;
    });
    ol.replaceChildren(...rows);
    if (!canPlay) {
      const note = Object.assign(document.createElement("p"), { className: "tracks-note", textContent: "This browser can't play these previews (they're Ogg Vorbis); they play in Zazabor, and in Chrome or Firefox." });
      ol.after(note);
    }
  }
})();
