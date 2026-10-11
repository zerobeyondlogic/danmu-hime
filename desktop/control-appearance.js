(function () {
  'use strict';

  const schema = window.ControlAppearanceSettings;
  const root = document.documentElement;
  const darkButton = document.getElementById('controlDarkButton');
  const lightButton = document.getElementById('controlLightButton');
  const opacityInput = document.getElementById('controlOpacityInput');
  const opacityValue = document.getElementById('controlOpacityValue');
  const hint = document.getElementById('controlAppearanceHint');
  const normalHint = '仅改变背景透明度，文字与控件保持清晰。';
  let initialized = false;
  let committed = schema.normalize(schema.defaults);
  let draft = { ...committed };
  let revision = 0;
  let saveTimer = null;
  let saveTask = null;

  function same(a, b) {
    return a.theme === b.theme && a.opacity === b.opacity;
  }

  function render() {
    root.dataset.controlTheme = draft.theme;
    root.style.setProperty('--control-opacity', String(draft.opacity / 100));
    darkButton.setAttribute('aria-pressed', String(draft.theme === 'dark'));
    lightButton.setAttribute('aria-pressed', String(draft.theme === 'light'));
    opacityInput.value = String(draft.opacity);
    opacityValue.textContent = draft.opacity + '%';
    for (const control of [darkButton, lightButton, opacityInput]) control.disabled = !initialized;
  }

  function showHint(text, error) {
    hint.textContent = text;
    hint.dataset.error = String(!!error);
  }

  function cancelSaveTimer() {
    if (saveTimer !== null) clearTimeout(saveTimer);
    saveTimer = null;
  }

  function savePending() {
    cancelSaveTimer();
    if (saveTask) return saveTask;
    if (!initialized) return Promise.resolve(true);
    if (same(draft, committed)) {
      showHint(normalHint, false);
      return Promise.resolve(true);
    }
    saveTask = Promise.resolve().then(async () => {
      let succeeded = true;
      while (!same(draft, committed)) {
        const snapshot = { ...draft };
        const savingRevision = revision;
        showHint('正在保存…', false);
        try {
          const result = await window.DesktopOverlay.setControlAppearance(snapshot);
          if (!result || !result.controlAppearance) throw new Error('Missing saved appearance');
          committed = schema.normalize(result.controlAppearance);
          if (revision === savingRevision) {
            draft = { ...committed };
            render();
          }
          succeeded = true;
          showHint(normalHint, false);
        } catch (error) {
          succeeded = false;
          if (revision === savingRevision) {
            draft = { ...committed };
            render();
            showHint('保存失败，已恢复上次保存的外观。请重试。', true);
            break;
          }
          if (same(draft, committed)) {
            succeeded = true;
            showHint(normalHint, false);
          }
          // Newer input replaces a failed in-flight value and gets one save
          // with the latest combined theme and opacity, not each slider step.
        }
      }
      return succeeded;
    }).finally(() => { saveTask = null; });
    return saveTask;
  }

  function change(patch) {
    if (!initialized) return;
    const next = schema.normalize({ ...draft, ...patch });
    if (same(next, draft)) return;
    draft = next;
    revision += 1;
    render();
    showHint('正在保存…', false);
    cancelSaveTimer();
    if (!saveTask) saveTimer = setTimeout(savePending, 140);
  }

  darkButton.addEventListener('click', () => change({ theme: 'dark' }));
  lightButton.addEventListener('click', () => change({ theme: 'light' }));
  opacityInput.addEventListener('input', () => change({ opacity: opacityInput.value }));
  opacityInput.addEventListener('change', () => { if (initialized) savePending(); });

  window.ControlAppearance = Object.freeze({
    initialize(value) {
      if (initialized) return;
      committed = schema.normalize(value);
      draft = { ...committed };
      initialized = true;
      render();
      showHint(normalHint, false);
    },
    async flush() {
      cancelSaveTimer();
      const succeeded = await savePending();
      if (!succeeded) return false;
      return same(draft, committed) ? true : savePending();
    }
  });
})();
