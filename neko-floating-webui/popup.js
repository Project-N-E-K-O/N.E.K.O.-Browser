(() => {
  const modeButtons = document.querySelectorAll('.modes button');
  const toggleButton = document.getElementById('toggle');
  const hintEl = document.getElementById('hint');
  const errorEl = document.getElementById('error');
  let currentMode = 'floating';
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
    if (currentMode === 'sidebar') {
      const openHere = activeSidePanelWindowId === currentWindowId;
      toggleButton.textContent = openHere ? '关闭侧栏' : '打开侧栏';
      hintEl.textContent = '侧栏由浏览器原生承载；麦克风和摄像头权限由 WebUI 直接请求。';
    } else {
      toggleButton.textContent = '显示 / 隐藏面板';
      hintEl.textContent = currentMode === 'fullscreen'
        ? '全屏显示时可点击和拖动 Live2D；需要操作原网页时，点击右上角胶囊隐藏叠加层。'
        : '浮窗可拖动和缩放；最小化后会卸载 WebUI 连接。';
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

  function normalizeDisplayMode(mode) {
    if (mode === 'fullscreen' || mode === 'sidebar') {
      return mode;
    }
    return 'floating';
  }

  function setControlsDisabled(disabled) {
    modeButtons.forEach((button) => {
      button.disabled = disabled;
    });
    toggleButton.disabled = disabled;
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
