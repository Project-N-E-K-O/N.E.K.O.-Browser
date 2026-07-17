(() => {
  const DEFAULT_WEBUI_URL = 'http://localhost:48911/';
  const modeButtons = document.querySelectorAll('.modes button');
  const toggleButton = document.getElementById('toggle');
  const hintEl = document.getElementById('hint');
  const errorEl = document.getElementById('error');
  const componentsHintEl = document.getElementById('components-hint');
  const chatSurfaceModeEl = document.getElementById('chat-surface-mode');
  const chatModeHintEl = document.getElementById('chat-mode-hint');
  const webuiUrlEl = document.getElementById('webui-url');
  const saveWebuiUrlButton = document.getElementById('save-webui-url');
  const resetWebuiUrlButton = document.getElementById('reset-webui-url');
  const authorizeMicrophoneButton = document.getElementById('authorize-microphone');
  const microphonePermissionHintEl = document.getElementById('microphone-permission-hint');
  const componentInputs = document.querySelectorAll('[data-surface-component]');
  const componentOrder = ['avatar', 'chat', 'subtitle', 'controls', 'agent-hud', 'status'];
  let currentMode = 'floating';
  let currentComponents = componentOrder.slice();
  let currentChatSurfaceMode = 'auto';
  let currentWebuiUrl = DEFAULT_WEBUI_URL;
  let microphonePermissionState = 'unknown';
  let microphonePermissionStatus = null;
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
      currentWebuiUrl = normalizeWebuiUrl(state?.webuiUrl) || DEFAULT_WEBUI_URL;
      currentWindowId = Number(currentWindow?.id);
      activeSidePanelWindowId = state?.activeSidePanelWindowId !== null
        && state?.activeSidePanelWindowId !== undefined
        && Number.isInteger(Number(state.activeSidePanelWindowId))
        ? Number(state.activeSidePanelWindowId)
        : null;
      render();
      setControlsDisabled(false);
      refreshMicrophonePermissionState();
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
    if (document.activeElement !== webuiUrlEl) {
      webuiUrlEl.value = currentWebuiUrl;
    }
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

  saveWebuiUrlButton.addEventListener('click', () => {
    saveWebuiUrl(webuiUrlEl.value);
  });

  resetWebuiUrlButton.addEventListener('click', () => {
    saveWebuiUrl(DEFAULT_WEBUI_URL);
  });

  webuiUrlEl.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      saveWebuiUrl(webuiUrlEl.value);
    }
  });

  authorizeMicrophoneButton.addEventListener('click', async () => {
    clearError();
    setControlsDisabled(true);
    try {
      await chrome.tabs.create({
        url: chrome.runtime.getURL('mic-permission.html')
      });
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

  async function saveWebuiUrl(value) {
    clearError();
    const nextUrl = normalizeWebuiUrl(value);
    if (!nextUrl) {
      showError(new Error('请输入有效的 HTTP 或 HTTPS 前端地址。'));
      return;
    }
    setControlsDisabled(true);
    try {
      const response = await chrome.runtime.sendMessage({
        type: 'NEKO_SET_WEBUI_URL',
        webuiUrl: nextUrl
      });
      assertOk(response);
      currentWebuiUrl = normalizeWebuiUrl(response?.webuiUrl) || nextUrl;
      webuiUrlEl.value = currentWebuiUrl;
    } catch (error) {
      showError(error);
      return;
    }
    setControlsDisabled(false);
  }

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

  function normalizeWebuiUrl(value) {
    try {
      let candidate = String(value || '').trim();
      if (!candidate) return null;
      if (!/^[a-z][a-z\d+.-]*:\/\//i.test(candidate)) {
        candidate = `http://${candidate}`;
      }
      const parsed = new URL(candidate);
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
      if (!parsed.hostname || parsed.username || parsed.password) return null;
      return parsed.toString();
    } catch {
      return null;
    }
  }

  async function refreshMicrophonePermissionState(options = {}) {
    if (!navigator.permissions?.query) {
      if (microphonePermissionState === 'unknown') {
        renderMicrophonePermissionState();
      }
      return;
    }
    try {
      microphonePermissionStatus = await navigator.permissions.query({ name: 'microphone' });
      microphonePermissionState = microphonePermissionStatus.state;
      microphonePermissionStatus.onchange = () => {
        microphonePermissionState = microphonePermissionStatus.state;
        renderMicrophonePermissionState();
      };
    } catch {
      if (microphonePermissionState === 'unknown') {
        microphonePermissionState = 'prompt';
      }
    }
    renderMicrophonePermissionState(options);
  }

  function renderMicrophonePermissionState(options = {}) {
    authorizeMicrophoneButton.dataset.state = microphonePermissionState;
    if (microphonePermissionState === 'granted') {
      authorizeMicrophoneButton.textContent = '麦克风已授权';
      microphonePermissionHintEl.textContent = '授权有效。浮窗和全屏可通过扩展后台获取麦克风。';
      return;
    }
    if (microphonePermissionState === 'denied') {
      authorizeMicrophoneButton.textContent = '重新授权麦克风';
      microphonePermissionHintEl.textContent = '麦克风已被阻止，请先在浏览器设置中解除阻止后再点击。';
      return;
    }
    authorizeMicrophoneButton.textContent = '授权麦克风';
    if (!options.preserveError) {
      microphonePermissionHintEl.textContent = '点击后会打开独立授权页，用于浮窗和全屏的扩展麦克风中继。';
    }
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
    webuiUrlEl.disabled = disabled;
    saveWebuiUrlButton.disabled = disabled;
    resetWebuiUrlButton.disabled = disabled;
    authorizeMicrophoneButton.disabled = disabled;
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
