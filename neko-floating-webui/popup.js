(() => {
  const modeButtons = document.querySelectorAll('.modes button');
  const toggleButton = document.getElementById('toggle');
  const hintEl = document.getElementById('hint');
  const errorEl = document.getElementById('error');
  const componentsHintEl = document.getElementById('components-hint');
  const chatSurfaceModeEl = document.getElementById('chat-surface-mode');
  const chatModeHintEl = document.getElementById('chat-mode-hint');
  const componentInputs = document.querySelectorAll('[data-surface-component]');
  const componentOrder = ['avatar', 'chat', 'subtitle', 'controls', 'agent-hud', 'status'];
  let currentMode = 'floating';
  let currentComponents = componentOrder.slice();
  let currentChatSurfaceMode = 'auto';
  let currentWindowId = null;
  let activeSidePanelWindowId = null;

  setControlsDisabled(true);

  async function refresh() {
    try {
      const [state, currentWindow] = await Promise.all([
        chrome.runtime.sendMessage({ type: 'NEKO_GET_STATE' }),
        chrome.windows.getCurrent()
      ]);
      currentMode = normalizeDisplayMode(state?.displayMode);
      currentComponents = normalizeSurfaceComponents(state?.surfaceComponents);
      currentChatSurfaceMode = normalizeChatSurfaceMode(state?.chatSurfaceMode);
      currentWindowId = Number(currentWindow?.id);
      activeSidePanelWindowId = state?.activeSidePanelWindowId !== null
        && state?.activeSidePanelWindowId !== undefined
        && Number.isInteger(Number(state.activeSidePanelWindowId))
        ? Number(state.activeSidePanelWindowId)
        : null;
      render();
      setControlsDisabled(false);
    } catch (error) {
      currentMode = 'floating';
      showError(error);
    }
  }

  function render() {
    modeButtons.forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.mode === currentMode);
    });
    const selected = new Set(currentComponents);
    chatSurfaceModeEl.value = currentChatSurfaceMode;
    componentInputs.forEach((input) => {
      input.checked = selected.has(input.dataset.surfaceComponent);
    });
    if (currentMode === 'sidebar') {
      const openHere = activeSidePanelWindowId === currentWindowId;
      toggleButton.textContent = openHere ? '关闭侧栏' : '打开侧栏';
      hintEl.textContent = '侧栏由浏览器原生承载；麦克风和摄像头权限由 WebUI 直接请求。';
      componentsHintEl.textContent = '侧栏使用独立页面；此设置会在下次打开浮窗或全屏时生效。';
      chatModeHintEl.textContent = '侧栏使用独立页面；固定模式只应用于浮窗和全屏。';
    } else {
      toggleButton.textContent = '显示 / 隐藏面板';
      hintEl.textContent = currentMode === 'fullscreen'
        ? '模型和聊天框可直接操作，未覆盖区域会穿透到原网页。'
        : '浮窗可拖动和缩放；最小化后会卸载 WebUI 连接。';
      componentsHintEl.textContent = currentMode === 'fullscreen'
        ? '开关会立即同步到当前全屏页面，并在下次打开时保留。'
        : '开关会立即同步到当前浮窗页面，并在下次打开时保留。';
      chatModeHintEl.textContent = currentChatSurfaceMode === 'auto'
        ? '当前跟随页面自身的小/大聊天框设置。'
        : `当前固定为${currentChatSurfaceMode === 'compact' ? '小' : '大'}聊天框。`;
    }
  }

  modeButtons.forEach((btn) => {
    btn.addEventListener('click', async () => {
      const mode = normalizeDisplayMode(btn.dataset.mode);
      clearError();
      try {
        if (mode === 'sidebar') {
          const openPromise = chrome.sidePanel.open({ windowId: currentWindowId });
          const modePromise = chrome.runtime.sendMessage({ type: 'NEKO_SET_DISPLAY_MODE', mode });
          const [, response] = await Promise.all([openPromise, modePromise]);
          assertOk(response);
        } else {
          const response = await chrome.runtime.sendMessage({ type: 'NEKO_SET_DISPLAY_MODE', mode });
          assertOk(response);
        }
        window.close();
      } catch (error) {
        showError(error);
      }
    });
  });

  toggleButton.addEventListener('click', async () => {
    clearError();
    try {
      if (currentMode === 'sidebar') {
        if (activeSidePanelWindowId === currentWindowId) {
          const response = await chrome.runtime.sendMessage({
            type: 'NEKO_SIDEBAR_RELEASE',
            windowId: currentWindowId
          });
          assertOk(response);
          await chrome.sidePanel.close({ windowId: currentWindowId });
        } else {
          const openPromise = chrome.sidePanel.open({ windowId: currentWindowId });
          const modePromise = chrome.runtime.sendMessage({
            type: 'NEKO_SET_DISPLAY_MODE',
            mode: 'sidebar'
          });
          const [, response] = await Promise.all([openPromise, modePromise]);
          assertOk(response);
        }
      } else {
        const response = await chrome.runtime.sendMessage({ type: 'NEKO_TOGGLE_FROM_POPUP' });
        assertOk(response);
      }
      window.close();
    } catch (error) {
      showError(error);
    }
  });

  componentInputs.forEach((input) => {
    input.addEventListener('change', async () => {
      clearError();
      setControlsDisabled(true);
      const next = componentOrder.filter((component) => {
        const target = document.querySelector(`[data-surface-component="${component}"]`);
        return target?.checked === true;
      });
      try {
        const response = await chrome.runtime.sendMessage({
          type: 'NEKO_SET_SURFACE_COMPONENTS',
          surfaceComponents: next
        });
        assertOk(response);
        currentComponents = normalizeSurfaceComponents(response?.surfaceComponents);
        render();
      } catch (error) {
        render();
        showError(error);
        return;
      }
      setControlsDisabled(false);
    });
  });

  chatSurfaceModeEl.addEventListener('change', async () => {
    clearError();
    setControlsDisabled(true);
    const previous = currentChatSurfaceMode;
    try {
      const response = await chrome.runtime.sendMessage({
        type: 'NEKO_SET_CHAT_SURFACE_MODE',
        chatSurfaceMode: normalizeChatSurfaceMode(chatSurfaceModeEl.value)
      });
      assertOk(response);
      currentChatSurfaceMode = normalizeChatSurfaceMode(response?.chatSurfaceMode);
      render();
    } catch (error) {
      currentChatSurfaceMode = previous;
      render();
      showError(error);
      return;
    }
    setControlsDisabled(false);
  });

  function normalizeDisplayMode(mode) {
    if (mode === 'fullscreen' || mode === 'sidebar') {
      return mode;
    }
    return 'floating';
  }

  function normalizeSurfaceComponents(value) {
    if (!Array.isArray(value)) {
      return componentOrder.slice();
    }
    const selected = new Set(value.map((item) => String(item || '').trim().toLowerCase()));
    return componentOrder.filter((component) => selected.has(component));
  }

  function normalizeChatSurfaceMode(value) {
    const normalized = String(value || '').trim().toLowerCase();
    return normalized === 'compact' || normalized === 'full' ? normalized : 'auto';
  }

  function setControlsDisabled(disabled) {
    modeButtons.forEach((button) => {
      button.disabled = disabled;
    });
    toggleButton.disabled = disabled;
    componentInputs.forEach((input) => {
      input.disabled = disabled;
    });
    chatSurfaceModeEl.disabled = disabled;
  }

  function assertOk(response) {
    if (response?.ok === false) {
      throw new Error(response.error || '操作失败。');
    }
  }

  function clearError() {
    errorEl.hidden = true;
    errorEl.textContent = '';
  }

  function showError(error) {
    errorEl.textContent = String(error?.message || error || '操作失败。');
    errorEl.hidden = false;
    setControlsDisabled(false);
  }

  refresh();
})();
