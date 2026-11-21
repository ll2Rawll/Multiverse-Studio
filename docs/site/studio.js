function enableTabs(list) {
  const tabs = [...list.querySelectorAll("[data-panel]")];
  const panels = tabs.map(tab => document.getElementById(tab.dataset.panel));
  if (panels.some(panel => !panel)) return;

  list.setAttribute("role", "tablist");
  tabs.forEach((tab, index) => {
    tab.setAttribute("role", "tab");
    tab.setAttribute("aria-controls", panels[index].id);
    panels[index].setAttribute("role", "tabpanel");
    panels[index].setAttribute("aria-labelledby", tab.id);
  });

  const measure = window.matchMedia("(max-width: 760px)");
  function setOrientation() {
    const vertical = list.dataset.tabs === "editors" && !measure.matches;
    list.setAttribute("aria-orientation", vertical ? "vertical" : "horizontal");
  }

  function select(index) {
    tabs.forEach((tab, n) => {
      const selected = index === n;
      tab.setAttribute("aria-selected", String(selected));
      tab.tabIndex = selected ? 0 : -1;
      tab.classList.toggle("is-active", selected);
      panels[n].hidden = !selected;
    });
  }

  tabs.forEach((tab, index) => {
    tab.addEventListener("click", event => {
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      event.preventDefault();
      select(index);
    });
    tab.addEventListener("keydown", event => {
      if (event.altKey || event.ctrlKey || event.metaKey) return;
      const vertical = list.getAttribute("aria-orientation") === "vertical";
      const forward = vertical ? "ArrowDown" : "ArrowRight";
      const back = vertical ? "ArrowUp" : "ArrowLeft";
      let next;
      switch (event.key) {
        case forward: next = (index + 1) % tabs.length; break;
        case back: next = (index + tabs.length - 1) % tabs.length; break;
        case "Home": next = 0; break;
        case "End": next = tabs.length - 1; break;
        case " ": next = index; break;
        default: return;
      }
      event.preventDefault();
      select(next);
      tabs[next].focus();
    });
  });
  setOrientation();
  measure.addEventListener("change", setOrientation);
  select(0);
}
document.querySelectorAll("[data-tabs]").forEach(enableTabs);

const film = document.getElementById("motion-cut");
const cues = [...document.querySelectorAll("[data-cue]")];
let pendingSeek;
function playFrom(seconds) {
  if (pendingSeek) film.removeEventListener("loadedmetadata", pendingSeek);
  if (film.readyState >= HTMLMediaElement.HAVE_METADATA) {
    film.currentTime = seconds;
  } else {
    pendingSeek = () => { film.currentTime = seconds; };
    film.addEventListener("loadedmetadata", pendingSeek, { once: true });
  }
  film.play().catch(() => {
    // The native controls stay available if the browser requires another tap.
    film.focus({ preventScroll: true });
  });
}
document.querySelector("[data-play-film]").addEventListener("click", event => {
  if (!event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey) playFrom(0);
});
cues.forEach(cue => {
  cue.addEventListener("click", event => {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    playFrom(Number(cue.dataset.cue));
  });
});
film.addEventListener("timeupdate", () => {
  const current = cues.filter(cue => Number(cue.dataset.cue) <= film.currentTime + 0.03).pop();
  cues.forEach(cue => {
    if (cue === current && !film.ended) cue.setAttribute("aria-current", "true");
    else cue.removeAttribute("aria-current");
  });
});

const copy = document.getElementById("copy-commands");
const commands = document.getElementById("commands");
const copyStatus = document.getElementById("copy-status");
let resetCopy;
copy.hidden = false;
copy.addEventListener("click", async () => {
  let copied = false;
  try {
    await navigator.clipboard.writeText(commands.textContent);
    copied = true;
  } catch {
    const range = document.createRange();
    range.selectNodeContents(commands);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    copied = document.execCommand("copy");
    if (copied) selection.removeAllRanges();
  }
  const result = copied ? "Copied" : "Commands selected";
  copy.querySelector("span").textContent = result;
  copyStatus.textContent = copied ? "Commands copied to clipboard." : "Commands selected. Use your device’s copy action.";
  clearTimeout(resetCopy);
  resetCopy = setTimeout(() => { copy.querySelector("span").textContent = "Copy commands"; }, 2200);
});
