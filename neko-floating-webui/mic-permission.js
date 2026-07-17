(() => {
  const requestButton = document.getElementById('request-microphone');
  const settingsButton = document.getElementById('open-microphone-settings');
  const closeButton = document.getElementById('close-page');
  const statusEl = document.getElementById('permission-status');
  const originEl = document.getElementById('extension-origin');
  let permissionStatus = null;

  originEl.textContent = location.origin;

  requestButton.addEventListener('click', authorizeMicrophone);
  settingsButton.addEventListener('click', openMicrophoneSettings);
  closeButton.addEventListener('click', () => window.close());

  refreshPermissionState();

  async function authorizeMicrophone() {
    setBusy(true);
    setStatus('prompt', '等待浏览器授权，请在权限提示中选择“允许”…');
    let stream = null;
    try {
      if (!navigator.mediaDevices?.getUserMedia) {
        throw new Error('当前浏览器不支持麦克风授权。');
      }
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      setStatus('granted', '麦克风授权成功。测试音轨已停止，现在可以关闭此页面并使用浮窗或全屏语音功能。');
    } catch (error) {
      const state = error?.name === 'NotAllowedError' ? 'denied' : 'error';
      setStatus(state, formatPermissionError(error));
    } finally {
      stream?.getTracks().forEach((track) => {
        try { track.stop(); } catch {}
      });
      setBusy(false);
      refreshPermissionState({ preserveMessage: true });
    }
  }

  async function refreshPermissionState(options = {}) {
    if (!navigator.permissions?.query) {
      if (!options.preserveMessage) {
        setStatus('prompt', '点击“请求麦克风权限”以继续。');
      }
      return;
    }
    try {
      permissionStatus = await navigator.permissions.query({ name: 'microphone' });
      permissionStatus.onchange = () => renderPermissionState(permissionStatus.state);
      if (!options.preserveMessage) {
        renderPermissionState(permissionStatus.state);
      }
    } catch {
      if (!options.preserveMessage) {
        setStatus('prompt', '点击“请求麦克风权限”以继续。');
      }
    }
  }

  function renderPermissionState(state) {
    if (state === 'granted') {
      setStatus('granted', '麦克风已经授权，可以直接使用浮窗或全屏语音功能。');
      return;
    }
    if (state === 'denied') {
      setStatus('denied', '麦克风权限已被阻止。请打开浏览器麦克风设置解除阻止，然后回到此页重试。');
      return;
    }
    setStatus('prompt', '尚未授权。点击“请求麦克风权限”后在浏览器提示中选择“允许”。');
  }

  function setStatus(state, message) {
    statusEl.dataset.state = state;
    statusEl.textContent = message;
    requestButton.textContent = state === 'granted' ? '重新检测麦克风' : '请求麦克风权限';
  }

  function setBusy(busy) {
    requestButton.disabled = busy;
    settingsButton.disabled = busy;
  }

  async function openMicrophoneSettings() {
    const settingsUrl = /Edg\//.test(navigator.userAgent)
      ? 'edge://settings/content/microphone'
      : 'chrome://settings/content/microphone';
    try {
      await chrome.tabs.create({ url: settingsUrl });
    } catch {
      setStatus('error', `无法自动打开设置，请手动访问 ${settingsUrl}`);
    }
  }

  function formatPermissionError(error) {
    const name = String(error?.name || '');
    const message = String(error?.message || '');
    if (name === 'NotAllowedError') {
      return /dismissed|取消|关闭/i.test(message)
        ? '授权提示已被关闭。请再次点击请求按钮，并在浏览器提示中选择“允许”。'
        : '麦克风权限未获允许。如果浏览器不再显示提示，请打开麦克风设置解除阻止。';
    }
    if (name === 'NotFoundError') {
      return '没有检测到可用的麦克风设备。';
    }
    if (name === 'NotReadableError') {
      return '麦克风正被其他程序占用，或设备暂时不可用。';
    }
    return message || '麦克风授权失败。';
  }
})();
