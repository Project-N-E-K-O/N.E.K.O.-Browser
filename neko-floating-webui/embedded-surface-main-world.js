(function () {
    'use strict';

    const params = new URLSearchParams(window.location.search);
    const surface = String(params.get('surface') || '').trim().toLowerCase();
    if (window.top === window || surface !== 'embed' || window.__nekoFloatingEmbeddedSurfaceLoaded) {
        return;
    }

    window.__nekoFloatingEmbeddedSurfaceLoaded = true;
    document.documentElement.classList.add('neko-embedded-surface');
    document.documentElement.dataset.nekoEmbeddedSurface = 'true';
    const initialComponents = params.has('components') ? params.get('components') : 'all';
    const initialChatMode = params.get('chat_mode');
    const initialAvatarForm = normalizeAvatarForm(params.get('avatar_form'));
    const initialAvatarFormRequestId = String(params.get('avatar_request_id') || '').trim() || null;

    const PROTOCOL_VERSION = 1;
    const MOBILE_VIEWPORT_MAX_WIDTH = 768;
    const POINTER_REGION_REFRESH_MS = 200;
    const CURSOR_BOUNDS_REFRESH_MS = 200;
    const COMPONENT_ORDER = Object.freeze(['avatar', 'chat', 'subtitle', 'controls', 'agent-hud', 'status']);
    const CHAT_SURFACE_MODES = Object.freeze(['auto', 'compact', 'full']);
    const UI_REGION_SELECTORS = Object.freeze({
        chat: [
            '#react-chat-window-shell',
            '#chat-avatar-preview-popup',
            '[data-compact-hit-region="true"]',
            '[data-compact-geometry-owner="surface"]',
            '#react-chat-window-root .compact-chat-surface-frame',
            '#react-chat-window-root .compact-chat-resize-handle',
            '#react-chat-window-root .compact-history-visibility-handle',
            '#react-chat-window-root .compact-export-history-anchor',
            '#react-chat-window-root .compact-meme-overlay',
            '#react-chat-window-root .compact-meme-overlay-close',
            '#react-chat-window-root .compact-music-player-mount',
            '#react-chat-window-root .composer-icon-popover',
            '#react-chat-window-root .composer-overflow-popover',
            '#react-chat-window-root .compact-input-tool-fan',
            '#react-chat-window-root .avatar-tool-quickbar',
            'body > .avatar-tool-manager-dialog',
            'body > .compact-chat-choice-anchor[data-choice-layer-open="true"] .composer-galgame-option',
            '#crop-overlay',
            'body > .jukebox-wrapper > .jukebox-container',
            'body > .jukebox-sam-panel'
        ],
        subtitle: [
            '#subtitle-display',
            '#subtitle-panel-controls',
            '#subtitle-settings-btn',
            '.subtitle-panel-control-btn',
            '#subtitle-settings-panel',
            '.subtitle-resize-edge'
        ],
        controls: [
            '[id$="-floating-buttons"]',
            '[id$="-lock-icon"]',
            '[id^="live2d-popup-"]',
            '[id^="vrm-popup-"]',
            '[id^="mmd-popup-"]',
            '[id^="pngtuber-popup-"]',
            '.live2d-popup',
            '.vrm-popup',
            '.mmd-popup',
            '.pngtuber-popup',
            '[data-neko-sidepanel]'
        ],
        'agent-hud': [
            '#agent-task-hud',
            '#agent-task-hud-header'
        ],
        status: [
            '#status-toast.show',
            '.neko-toast',
            '[data-neko-toast]'
        ],
        avatar: [
            '[id$="-return-button-container"]',
            '#avatar-reaction-bubble.is-visible',
            '[data-neko-embed-interactive="avatar"]'
        ]
    });

    let enabledComponents = new Set(normalizeComponents(initialComponents));
    let fixedChatMode = normalizeChatMode(initialChatMode);
    let pageChatMode = null;
    let connectedParentOrigin = null;
    let regionFrame = 0;
    let chatVisibilityFrame = 0;
    let chatVisibilityPending = false;
    let lastRegionSignature = '';
    let managerSyncTicks = 0;
    let pointerRelayFrame = 0;
    let pendingPointerRelay = null;
    let pointerRegionRefreshTimer = 0;
    let lastPointerRegionRefreshAt = 0;
    let cachedElementRegions = null;
    let cachedAvatarBoundsRegion = null;
    let responsiveViewportFrame = 0;
    let lastMobileViewport = isMobileViewport();
    let requestedAvatarForm = initialAvatarForm;
    let avatarFormRequestId = initialAvatarFormRequestId;
    let avatarFormSyncTimer = 0;
    let avatarFormDispatchedAt = 0;
    let avatarModelReturnDispatchedAt = 0;
    let lastAvatarFormReport = '';
    const managersPausedBySurface = new WeakSet();
    const optimizedCursorFollowers = new WeakSet();
    const cursorBoundsStates = new WeakMap();

    if (requestedAvatarForm === 'cat') {
        document.documentElement.dataset.nekoAvatarFormRequest = 'cat';
        document.documentElement.dataset.nekoAvatarFormState = 'pending';
    }

    function normalizeComponents(value) {
        let values = value;
        if (typeof values === 'string') {
            const normalizedText = values.trim().toLowerCase();
            if (normalizedText === 'all') return COMPONENT_ORDER.slice();
            if (normalizedText === 'none') return [];
            values = normalizedText.replace(/;/g, ',').split(',');
        }
        if (!Array.isArray(values)) return [];

        const selected = new Set();
        values.forEach((valueItem) => {
            const name = String(valueItem || '').trim().toLowerCase();
            if (COMPONENT_ORDER.includes(name)) selected.add(name);
        });
        return COMPONENT_ORDER.filter((name) => selected.has(name));
    }

    function normalizeChatMode(value) {
        const normalized = String(value || '').trim().toLowerCase();
        return CHAT_SURFACE_MODES.includes(normalized) ? normalized : 'auto';
    }

    function normalizeAvatarForm(value) {
        const normalized = String(value || '').trim().toLowerCase();
        if (normalized === 'cat' || normalized === 'model') return normalized;
        return null;
    }

    function isMobileViewport() {
        return window.innerWidth <= MOBILE_VIEWPORT_MAX_WIDTH;
    }

    function findActiveAvatarManager() {
        const candidates = [
            { prefix: 'live2d', manager: window.live2dManager },
            { prefix: 'vrm', manager: window.vrmManager },
            { prefix: 'mmd', manager: window.mmdManager },
            { prefix: 'pngtuber', manager: window.pngtuberManager }
        ].filter((candidate) => candidate.manager && typeof candidate.manager.setupFloatingButtons === 'function');

        return candidates.find((candidate) => (
            document.getElementById(`${candidate.prefix}-floating-buttons`)
            || document.getElementById(`${candidate.prefix}-lock-icon`)
            || document.getElementById(`${candidate.prefix}-return-button-container`)
        )) || null;
    }

    function rebuildActiveAvatarControls() {
        const active = findActiveAvatarManager();
        if (!active) return false;
        const manager = active.manager;
        if (manager._isInReturnState || manager._goodbyeClicked) return false;

        try {
            if (active.prefix === 'live2d') {
                const model = manager.currentModel;
                if (!model || model.destroyed) return false;
                manager.setupFloatingButtons(model);
            } else {
                manager.setupFloatingButtons();
            }
            return true;
        } catch (_) {
            return false;
        }
    }

    function syncResponsiveViewportMode() {
        const mobileViewport = isMobileViewport();
        if (mobileViewport === lastMobileViewport) return false;
        const controlsRebuilt = rebuildActiveAvatarControls();
        syncFixedChatMode();
        scheduleChatVisibilityCheck();
        scheduleRegionReport();
        if (!controlsRebuilt) return false;
        lastMobileViewport = mobileViewport;
        return true;
    }

    function scheduleResponsiveViewportSync() {
        if (responsiveViewportFrame) return;
        responsiveViewportFrame = window.requestAnimationFrame(() => {
            responsiveViewportFrame = 0;
            syncResponsiveViewportMode();
        });
    }

    function getAvatarManagers() {
        return [
            window.live2dManager,
            window.vrmManager,
            window.mmdManager,
            window.pngtuberManager
        ].filter(Boolean);
    }

    function getVisibleReturnContainer() {
        const containers = document.querySelectorAll(
            '[id$="-return-button-container"][data-neko-return-visible="true"]'
        );
        return Array.from(containers).find((container) => isRendered(container)) || null;
    }

    function hasAcceptedGoodbyeState() {
        if (document.querySelector('[id$="-return-button-container"][data-neko-return-visible="true"]')) {
            return true;
        }
        return getAvatarManagers().some((manager) => (
            manager._goodbyeClicked === true || manager._isInReturnState === true
        ));
    }

    function hasGoodbyeEntryPoint() {
        return Boolean(document.querySelector(
            '#live2d-btn-goodbye, #vrm-btn-goodbye, #mmd-btn-goodbye, #pngtuber-btn-goodbye'
        ));
    }

    function detectAvatarFormState() {
        const returnContainer = getVisibleReturnContainer();
        if (returnContainer) {
            return {
                avatarForm: 'cat',
                visible: true,
                status: 'applied',
                returnContainerId: returnContainer.id || null
            };
        }
        if (hasAcceptedGoodbyeState()) {
            return {
                avatarForm: 'cat',
                visible: false,
                status: 'transitioning',
                returnContainerId: null
            };
        }
        if (hasGoodbyeEntryPoint() || getAvatarManagers().length > 0) {
            return {
                avatarForm: 'model',
                visible: true,
                status: 'applied',
                returnContainerId: null
            };
        }
        return {
            avatarForm: 'model',
            visible: false,
            status: 'waiting',
            returnContainerId: null
        };
    }

    function reportAvatarFormState(source, force) {
        const state = detectAvatarFormState();
        const requestApplied = requestedAvatarForm === 'cat'
            ? state.avatarForm === 'cat' && state.visible
            : (requestedAvatarForm === 'model'
                ? state.avatarForm === 'model' && state.status === 'applied'
                : state.status === 'applied');
        const payload = {
            avatarForm: state.avatarForm,
            avatarFormRequestId,
            requestedAvatarForm,
            visible: state.visible,
            status: requestApplied
                ? 'applied'
                : (state.status === 'waiting' ? 'waiting' : 'transitioning'),
            returnContainerId: state.returnContainerId,
            source: source || 'host-observer'
        };
        const signature = JSON.stringify(payload);
        if (!force && signature === lastAvatarFormReport) return state;
        lastAvatarFormReport = signature;
        postToParent('NEKO_EMBED_AVATAR_FORM_STATE', payload);
        return state;
    }

    function scheduleAvatarFormSync(delayMs = 0, source = 'host-observer') {
        if (avatarFormSyncTimer) return;
        avatarFormSyncTimer = window.setTimeout(() => {
            avatarFormSyncTimer = 0;
            syncRequestedAvatarForm(source);
        }, Math.max(0, Number(delayMs) || 0));
    }

    function requestAvatarForm(value, requestId, source) {
        const nextForm = normalizeAvatarForm(value);
        if (nextForm !== 'cat') {
            if (requestedAvatarForm !== 'model') {
                avatarModelReturnDispatchedAt = 0;
            }
            requestedAvatarForm = nextForm === 'model' ? 'model' : null;
            avatarFormRequestId = null;
            avatarFormDispatchedAt = 0;
            delete document.documentElement.dataset.nekoAvatarFormRequest;
            document.documentElement.dataset.nekoAvatarFormState = 'pending-model';
            scheduleAvatarFormSync(0, source || 'parent-request');
            return;
        }
        requestedAvatarForm = 'cat';
        avatarFormRequestId = String(requestId || avatarFormRequestId || '').trim() || null;
        avatarModelReturnDispatchedAt = 0;
        document.documentElement.dataset.nekoAvatarFormRequest = 'cat';
        document.documentElement.dataset.nekoAvatarFormState = 'pending';
        scheduleAvatarFormSync(0, source || 'parent-request');
    }

    function syncRequestedAvatarForm(source) {
        const state = detectAvatarFormState();
        if (requestedAvatarForm !== 'cat') {
            if (requestedAvatarForm === 'model' && state.avatarForm === 'cat') {
                document.documentElement.dataset.nekoAvatarFormState = 'pending-model';
                const now = Date.now();
                if (!avatarModelReturnDispatchedAt || now - avatarModelReturnDispatchedAt >= 2000) {
                    avatarModelReturnDispatchedAt = now;
                    dispatchAvatarReturnToModel();
                }
                reportAvatarFormState(source || 'parent-request', true);
                scheduleAvatarFormSync(150, 'parent-request');
                return false;
            }
            if (state.status === 'applied') {
                document.documentElement.dataset.nekoAvatarFormState = state.avatarForm;
                if (requestedAvatarForm === 'model') {
                    syncResponsiveViewportMode();
                }
            }
            reportAvatarFormState(source || 'host-observer', false);
            return state.status === 'applied';
        }

        if (state.avatarForm === 'cat' && state.visible) {
            document.documentElement.dataset.nekoAvatarFormState = 'cat';
            reportAvatarFormState(source || 'host-observer', false);
            scheduleRegionReport();
            return true;
        }

        document.documentElement.dataset.nekoAvatarFormState = 'pending';
        if (state.avatarForm === 'cat') {
            reportAvatarFormState(source || 'host-transition', true);
            scheduleAvatarFormSync(150, 'host-transition');
            return false;
        }

        if (document.readyState !== 'complete' || !hasGoodbyeEntryPoint()) {
            reportAvatarFormState(source || 'host-waiting', false);
            scheduleAvatarFormSync(250, 'host-waiting');
            return false;
        }

        const now = Date.now();
        if (!avatarFormDispatchedAt || now - avatarFormDispatchedAt >= 2000) {
            avatarFormDispatchedAt = now;
            window.dispatchEvent(new CustomEvent('live2d-goodbye-click', {
                detail: {
                    source: 'browser-extension-avatar-form',
                    reason: 'floating-minimized-to-fullscreen',
                    avatarFormRequestId
                }
            }));
        }
        reportAvatarFormState('extension-request', true);
        scheduleAvatarFormSync(150, 'extension-request');
        return false;
    }

    function dispatchAvatarReturnToModel() {
        const container = document.querySelector(
            '[id$="-return-button-container"][data-neko-return-visible="true"]'
        );
        let prefix = null;
        let rect = null;
        if (container) {
            const match = String(container.id || '').match(/^([a-z0-9-]+)-return-button-container$/i);
            prefix = match && match[1] ? match[1] : null;
            const bounds = container.getBoundingClientRect();
            rect = {
                left: bounds.left,
                top: bounds.top,
                width: bounds.width,
                height: bounds.height
            };
        }
        if (!prefix) {
            const active = [
                ['live2d', window.live2dManager],
                ['vrm', window.vrmManager],
                ['mmd', window.mmdManager],
                ['pngtuber', window.pngtuberManager]
            ].find(([, manager]) => manager && (
                manager._goodbyeClicked === true || manager._isInReturnState === true
            ));
            prefix = active ? active[0] : null;
        }
        if (!prefix) return false;
        window.dispatchEvent(new CustomEvent(`${prefix}-return-click`, {
            detail: rect ? { returnButtonRect: rect } : {}
        }));
        return true;
    }

    function getCurrentChatMode() {
        const host = window.reactChatWindowHost;
        if (host && typeof host.getChatSurfaceMode === 'function') {
            try {
                const mode = String(host.getChatSurfaceMode() || '').trim().toLowerCase();
                if (mode === 'compact' || mode === 'full' || mode === 'minimized') return mode;
            } catch (_) {}
        }
        const shell = document.getElementById('react-chat-window-shell');
        const shellMode = shell && String(shell.dataset.chatSurfaceMode || '').trim().toLowerCase();
        if (shellMode === 'compact' || shellMode === 'full' || shellMode === 'minimized') return shellMode;
        const initialMode = document.body
            && String(document.body.dataset.initialChatSurfaceMode || '').trim().toLowerCase();
        return initialMode === 'full' ? 'full' : (initialMode === 'compact' ? 'compact' : null);
    }

    function rememberPageChatMode(mode) {
        if (mode === 'compact' || mode === 'full') pageChatMode = mode;
        else if (mode === 'minimized' && !pageChatMode) pageChatMode = 'compact';
    }

    function callHostChatMode(mode) {
        const host = window.reactChatWindowHost;
        if (!host || typeof host.setChatSurfaceMode !== 'function') return false;
        try {
            host.setChatSurfaceMode(mode);
            return true;
        } catch (_) {
            return false;
        }
    }

    function syncFixedChatMode() {
        const current = getCurrentChatMode();
        if (!pageChatMode) rememberPageChatMode(current);
        if (fixedChatMode === 'auto' || current === fixedChatMode) return current;
        callHostChatMode(fixedChatMode);
        return getCurrentChatMode();
    }

    function ensureEmbeddedChatVisible() {
        const shell = document.getElementById('react-chat-window-shell');
        const host = window.reactChatWindowHost;
        if (!shell || !host || typeof host.ensureChatSurfaceVisible !== 'function') return null;
        if (getCurrentChatMode() === 'minimized') return false;
        try {
            return host.ensureChatSurfaceVisible() === true;
        } catch (_) {
            return false;
        }
    }

    function scheduleChatVisibilityCheck() {
        chatVisibilityPending = true;
        if (chatVisibilityFrame) return;
        chatVisibilityFrame = window.requestAnimationFrame(() => {
            chatVisibilityFrame = 0;
            const moved = ensureEmbeddedChatVisible();
            if (moved === null) return;
            chatVisibilityPending = false;
            if (moved) scheduleRegionReport();
        });
    }

    function setFixedChatMode(nextMode, source) {
        const previousMode = fixedChatMode;
        const current = getCurrentChatMode();
        if (previousMode === 'auto') rememberPageChatMode(current);
        fixedChatMode = normalizeChatMode(nextMode);
        if (fixedChatMode === 'auto') {
            if (pageChatMode && current !== pageChatMode) callHostChatMode(pageChatMode);
        } else {
            syncFixedChatMode();
        }
        scheduleRegionReport();
        const detail = {
            chatMode: fixedChatMode,
            currentMode: getCurrentChatMode(),
            source: source || 'runtime'
        };
        postToParent('NEKO_EMBED_CHAT_MODE_CHANGED', detail);
        return detail;
    }

    function componentList() {
        return COMPONENT_ORDER.filter((name) => enabledComponents.has(name));
    }

    function componentState() {
        return COMPONENT_ORDER.reduce((state, name) => {
            state[name] = enabledComponents.has(name);
            return state;
        }, {});
    }

    function applyComponentState(source) {
        const root = document.documentElement;
        COMPONENT_ORDER.forEach((name) => {
            root.dataset[componentDatasetKey(name)] = enabledComponents.has(name) ? 'on' : 'off';
        });

        if (document.body) {
            document.body.dataset.nekoEmbeddedSurface = 'true';
            document.body.dataset.nekoSurfaceComponents = componentList().join(',');
        }

        syncAvatarRendering();
        scheduleRegionReport();

        const detail = {
            components: componentList(),
            state: componentState(),
            source: source || 'runtime'
        };
        window.dispatchEvent(new CustomEvent('neko-embedded-components-change', { detail }));
        postToParent('NEKO_EMBED_COMPONENTS_CHANGED', detail);
        return detail;
    }

    function setComponents(nextComponents, source) {
        const normalized = normalizeComponents(nextComponents);
        const previous = componentList();
        if (previous.length === normalized.length && previous.every((name, index) => name === normalized[index])) {
            scheduleRegionReport();
            return {
                components: previous,
                state: componentState(),
                source: source || 'runtime'
            };
        }
        enabledComponents = new Set(normalized);
        return applyComponentState(source);
    }

    function setComponentEnabled(name, enabled, source) {
        const normalizedNames = normalizeComponents([name]);
        if (!normalizedNames.length) return null;
        const normalizedName = normalizedNames[0];
        const next = new Set(enabledComponents);
        if (enabled) next.add(normalizedName);
        else next.delete(normalizedName);
        return setComponents(Array.from(next), source);
    }

    function toggleComponent(name, source) {
        const normalizedNames = normalizeComponents([name]);
        if (!normalizedNames.length) return null;
        const normalizedName = normalizedNames[0];
        return setComponentEnabled(normalizedName, !enabledComponents.has(normalizedName), source);
    }

    function syncAvatarRendering() {
        const avatarEnabled = enabledComponents.has('avatar');
        optimizeCursorFollow(window.vrmManager, window.vrmManager?._cursorFollow, 'updateTarget');
        optimizeCursorFollow(window.mmdManager, window.mmdManager?.cursorFollow, 'update');
        [
            window.live2dManager,
            window.vrmManager,
            window.mmdManager,
            window.pngtuberManager
        ].forEach((manager) => {
            if (!manager) return;
            if (!avatarEnabled && typeof manager.pauseRendering === 'function') {
                try {
                    manager.pauseRendering();
                    managersPausedBySurface.add(manager);
                } catch (_) {}
                return;
            }
            if (avatarEnabled && managersPausedBySurface.has(manager) && typeof manager.resumeRendering === 'function') {
                try {
                    manager.resumeRendering();
                    managersPausedBySurface.delete(manager);
                } catch (_) {}
            }
        });
    }

    function normalizeThreeScreenBounds(bounds) {
        if (!bounds || typeof bounds !== 'object') return null;
        const left = Number(bounds.left ?? bounds.minX);
        const right = Number(bounds.right ?? bounds.maxX);
        const top = Number(bounds.top ?? bounds.minY);
        const bottom = Number(bounds.bottom ?? bounds.maxY);
        if (![left, right, top, bottom].every(Number.isFinite)
            || right <= left || bottom <= top) {
            return null;
        }
        return {
            left,
            right,
            top,
            bottom,
            width: right - left,
            height: bottom - top,
            centerX: (left + right) / 2,
            centerY: (top + bottom) / 2
        };
    }

    function readCursorFollowBounds(manager) {
        const model = manager && manager.currentModel;
        if (!manager || !model) return null;

        const now = performance.now();
        const interaction = manager.interaction;
        const interactionSource = interaction?._cachedScreenBounds || null;
        const interactionRevision = Number(
            interaction?._lastModelUpdateTime ?? interaction?._lastBoundsUpdateTime
        ) || 0;
        let state = cursorBoundsStates.get(manager);

        if (!state || state.model !== model) {
            const freshBounds = typeof manager.getModelScreenBounds === 'function'
                ? normalizeThreeScreenBounds(manager.getModelScreenBounds())
                : null;
            state = {
                model,
                bounds: freshBounds,
                updatedAt: now,
                interactionSource,
                interactionRevision
            };
            cursorBoundsStates.set(manager, state);
            return freshBounds;
        }

        if (interactionSource
            && (interactionSource !== state.interactionSource
                || interactionRevision !== state.interactionRevision)) {
            const interactionBounds = normalizeThreeScreenBounds(interactionSource);
            if (interactionBounds) {
                state.bounds = interactionBounds;
                state.updatedAt = now;
            }
            state.interactionSource = interactionSource;
            state.interactionRevision = interactionRevision;
            return state.bounds;
        }

        if (now - state.updatedAt < CURSOR_BOUNDS_REFRESH_MS) {
            return state.bounds;
        }

        state.bounds = typeof manager.getModelScreenBounds === 'function'
            ? normalizeThreeScreenBounds(manager.getModelScreenBounds())
            : null;
        state.updatedAt = now;
        state.interactionSource = interactionSource;
        state.interactionRevision = interactionRevision;
        return state.bounds;
    }

    function optimizeCursorFollow(manager, cursorFollow, methodName) {
        if (!manager || !cursorFollow || optimizedCursorFollowers.has(cursorFollow)) return;
        const original = cursorFollow[methodName];
        if (typeof original !== 'function') return;

        const managerFacade = Object.create(manager);
        Object.defineProperty(managerFacade, 'getModelScreenBounds', {
            configurable: false,
            enumerable: false,
            value: () => readCursorFollowBounds(manager)
        });

        cursorFollow[methodName] = function (...args) {
            const realManager = this.manager;
            if (realManager !== manager) {
                return original.apply(this, args);
            }
            this.manager = managerFacade;
            try {
                return original.apply(this, args);
            } finally {
                this.manager = realManager;
            }
        };
        optimizedCursorFollowers.add(cursorFollow);
    }

    function capitalize(value) {
        return value.charAt(0).toUpperCase() + value.slice(1);
    }

    function componentDatasetKey(name) {
        return `nekoSurface${name.split('-').map(capitalize).join('')}`;
    }

    function isRendered(element) {
        if (!element || !element.isConnected || element.hidden) return false;
        const style = window.getComputedStyle(element);
        if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) return false;
        const rect = element.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
    }

    function acceptsPointerlessRegion(component, element) {
        return component === 'subtitle'
            && element.id === 'subtitle-display'
            && isDanmakuSubtitleDisplay(element);
    }

    function isDanmakuSubtitleDisplay(element) {
        if (element.dataset.subtitleDanmakuActive === 'true') return true;
        const toggle = document.getElementById('subtitle-danmaku-mode-btn');
        if (toggle && toggle.checked === true) return true;
        try {
            const settings = window.nekoSubtitleShared
                && typeof window.nekoSubtitleShared.getSettings === 'function'
                ? window.nekoSubtitleShared.getSettings()
                : null;
            return settings && settings.subtitleDanmakuMode === true;
        } catch (_) {
            return false;
        }
    }

    function rectToPayload(rect) {
        const left = Math.max(0, rect.left);
        const top = Math.max(0, rect.top);
        const right = Math.min(window.innerWidth, rect.right);
        const bottom = Math.min(window.innerHeight, rect.bottom);
        if (right <= left || bottom <= top) return null;
        return {
            left: round(left),
            top: round(top),
            right: round(right),
            bottom: round(bottom),
            width: round(right - left),
            height: round(bottom - top)
        };
    }

    function round(value) {
        return Math.round(value * 100) / 100;
    }

    function collectElementRegions() {
        const regions = [];
        const seen = new Set();

        Object.entries(UI_REGION_SELECTORS).forEach(([component, selectors]) => {
            if (!enabledComponents.has(component)) return;
            selectors.forEach((selector) => {
                document.querySelectorAll(selector).forEach((element) => {
                    if (seen.has(element) || !isRendered(element)) return;
                    const style = window.getComputedStyle(element);
                    if (style.pointerEvents === 'none' && !acceptsPointerlessRegion(component, element)) return;
                    const rect = rectToPayload(element.getBoundingClientRect());
                    if (!rect) return;
                    seen.add(element);
                    regions.push({
                        component,
                        kind: 'ui',
                        id: element.id || element.getAttribute('data-neko-embed-region') || selector,
                        rect
                    });
                });
            });
        });

        return regions;
    }

    function collectAvatarBoundsRegion() {
        if (!enabledComponents.has('avatar')) return null;

        const live2dRegion = getLive2DBoundsRegion();
        if (live2dRegion) return live2dRegion;

        const vrmRegion = getThreeBoundsRegion(window.vrmManager, 'vrm-model');
        if (vrmRegion) return vrmRegion;

        const mmdRegion = getThreeBoundsRegion(window.mmdManager, 'mmd-model');
        if (mmdRegion) return mmdRegion;

        const pngtuberRegion = getPngtuberBoundsRegion();
        if (pngtuberRegion) return pngtuberRegion;

        return null;
    }

    function getLive2DBoundsRegion() {
        const manager = window.live2dManager;
        const model = manager && manager.currentModel;
        const canvas = document.getElementById('live2d-canvas');
        if (!model || !canvas || !isRendered(canvas) || typeof model.getBounds !== 'function') return null;

        try {
            const bounds = model.getBounds();
            const canvasRect = canvas.getBoundingClientRect();
            const rendererScreen = manager.pixi_app && manager.pixi_app.renderer
                ? manager.pixi_app.renderer.screen
                : null;
            const rendererWidth = rendererScreen && Number(rendererScreen.width) > 0
                ? Number(rendererScreen.width)
                : canvasRect.width;
            const rendererHeight = rendererScreen && Number(rendererScreen.height) > 0
                ? Number(rendererScreen.height)
                : canvasRect.height;
            const scaleX = canvasRect.width / rendererWidth;
            const scaleY = canvasRect.height / rendererHeight;
            const left = canvasRect.left + Number(bounds.left ?? bounds.x) * scaleX;
            const top = canvasRect.top + Number(bounds.top ?? bounds.y) * scaleY;
            const width = Number(bounds.width ?? (bounds.right - bounds.left)) * scaleX;
            const height = Number(bounds.height ?? (bounds.bottom - bounds.top)) * scaleY;
            if (![left, top, width, height].every(Number.isFinite) || width <= 0 || height <= 0) return null;
            const rect = rectToPayload({ left, top, right: left + width, bottom: top + height });
            return rect ? { component: 'avatar', kind: 'model-bounds', id: 'live2d-model', rect } : null;
        } catch (_) {
            return null;
        }
    }

    function getThreeBoundsRegion(manager, id) {
        if (!manager) return null;
        const canvas = manager.renderer && manager.renderer.domElement;
        if (!canvas || !isRendered(canvas)) return null;
        try {
            // The host interaction layer already maintains this at its own
            // throttled cadence. Reading it keeps region reporting cheap and
            // leaves the manager's public geometry method untouched.
            const cachedBounds = normalizeThreeScreenBounds(manager.interaction?._cachedScreenBounds);
            const bounds = cachedBounds
                || (typeof manager.getModelScreenBounds === 'function'
                    ? normalizeThreeScreenBounds(manager.getModelScreenBounds())
                    : null);
            if (!bounds) return null;
            const rect = rectToPayload(bounds);
            return rect ? { component: 'avatar', kind: 'model-bounds', id, rect } : null;
        } catch (_) {
            return null;
        }
    }

    function getPngtuberBoundsRegion() {
        const manager = window.pngtuberManager;
        const element = manager && (manager.image || manager.imageElement || manager.canvasElement);
        if (!element || !isRendered(element)) return null;
        const rect = rectToPayload(element.getBoundingClientRect());
        return rect ? { component: 'avatar', kind: 'model-bounds', id: 'pngtuber-model', rect } : null;
    }

    function collectRegions() {
        const regions = collectElementRegions();
        const avatarRegion = collectAvatarBoundsRegion();
        if (avatarRegion) regions.push(avatarRegion);
        cachedElementRegions = regions.filter((region) => region !== avatarRegion);
        cachedAvatarBoundsRegion = avatarRegion;
        return regions;
    }

    function scheduleRegionReport() {
        if (regionFrame) return;
        regionFrame = window.requestAnimationFrame(() => {
            regionFrame = 0;
            reportRegions();
        });
    }

    function schedulePointerRegionRefresh() {
        const now = performance.now();
        const elapsed = now - lastPointerRegionRefreshAt;
        if (elapsed >= POINTER_REGION_REFRESH_MS) {
            lastPointerRegionRefreshAt = now;
            scheduleRegionReport();
            return;
        }
        if (pointerRegionRefreshTimer) return;
        pointerRegionRefreshTimer = window.setTimeout(() => {
            pointerRegionRefreshTimer = 0;
            lastPointerRegionRefreshAt = performance.now();
            scheduleRegionReport();
        }, Math.max(0, POINTER_REGION_REFRESH_MS - elapsed));
    }

    function reportRegions(force) {
        const regions = collectRegions();
        const signature = JSON.stringify(regions);
        if (!force && signature === lastRegionSignature) return regions;
        lastRegionSignature = signature;
        postToParent('NEKO_EMBED_INTERACTIVE_REGIONS', {
            components: componentList(),
            regions,
            viewport: {
                width: window.innerWidth,
                height: window.innerHeight,
                devicePixelRatio: window.devicePixelRatio || 1
            }
        });
        return regions;
    }

    function pointInRect(x, y, rect) {
        return x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
    }

    function pointInAvatarConservativeBounds(x, y, bounds) {
        const centerX = (bounds.left + bounds.right) / 2;
        const centerY = (bounds.top + bounds.bottom) / 2;
        // Keep only the model-centered portion of the broad Three.js Box3.
        // The 40% x 90% inset matches the narrow visible-avatar interaction
        // zone while leaving the surrounding host page click-through.
        const halfWidth = (bounds.right - bounds.left) * 0.5 * 0.4;
        const halfHeight = (bounds.bottom - bounds.top) * 0.5 * 0.9;
        if (!(halfWidth > 0) || !(halfHeight > 0)) return false;
        return Math.abs(x - centerX) <= halfWidth
            && Math.abs(y - centerY) <= halfHeight;
    }

    function hitTestUi(x, y) {
        const regions = cachedElementRegions || collectElementRegions();
        for (let index = regions.length - 1; index >= 0; index -= 1) {
            const region = regions[index];
            if (pointInRect(x, y, region.rect)) return region;
        }
        return null;
    }

    function hitTestLive2D(x, y) {
        const manager = window.live2dManager;
        const model = manager && manager.currentModel;
        const canvas = document.getElementById('live2d-canvas');
        if (!model || !canvas || !isRendered(canvas) || typeof model.getBounds !== 'function') return false;

        try {
            const canvasRect = canvas.getBoundingClientRect();
            const rendererScreen = manager.pixi_app && manager.pixi_app.renderer
                ? manager.pixi_app.renderer.screen
                : null;
            const rendererWidth = rendererScreen && Number(rendererScreen.width) > 0
                ? Number(rendererScreen.width)
                : canvasRect.width;
            const rendererHeight = rendererScreen && Number(rendererScreen.height) > 0
                ? Number(rendererScreen.height)
                : canvasRect.height;
            const rendererX = (x - canvasRect.left) * (rendererWidth / canvasRect.width);
            const rendererY = (y - canvasRect.top) * (rendererHeight / canvasRect.height);
            const bounds = model.getBounds();
            const left = Number(bounds.left ?? bounds.x);
            const top = Number(bounds.top ?? bounds.y);
            const width = Number(bounds.width ?? (bounds.right - bounds.left));
            const height = Number(bounds.height ?? (bounds.bottom - bounds.top));
            if (![rendererX, rendererY, left, top, width, height].every(Number.isFinite)) return false;
            if (width <= 0 || height <= 0) return false;
            if (rendererX < left || rendererX > left + width || rendererY < top || rendererY > top + height) return false;

            if (typeof model.hitTest === 'function') {
                try {
                    const areas = model.hitTest(rendererX, rendererY);
                    if (areas && areas.length > 0) return true;
                } catch (_) {}
            }

            const centerX = left + width / 2;
            const centerY = top + height / 2;
            const radiusX = width * 0.3;
            const radiusY = height * 0.45;
            if (radiusX <= 0 || radiusY <= 0) return false;
            const normalizedX = (rendererX - centerX) / radiusX;
            const normalizedY = (rendererY - centerY) / radiusY;
            return normalizedX * normalizedX + normalizedY * normalizedY <= 1;
        } catch (_) {
            return false;
        }
    }

    function hitTestThreeManager(manager, x, y) {
        if (!manager) return false;
        const canvas = manager.renderer && manager.renderer.domElement;
        if (!canvas || !isRendered(canvas)) return false;

        // Never raycast the animated hierarchy during hover. Prefer the
        // adapter's bounded-cadence region report because it is refreshed
        // without replacing host manager methods; use the host interaction
        // cache only before the first report is available.
        const expectedId = manager === window.vrmManager ? 'vrm-model' : 'mmd-model';
        const reportedBounds = cachedAvatarBoundsRegion?.id === expectedId
            ? normalizeThreeScreenBounds(cachedAvatarBoundsRegion.rect)
            : null;
        const interactionBounds = normalizeThreeScreenBounds(manager.interaction?._cachedScreenBounds);
        const bounds = interactionBounds || reportedBounds;
        return bounds ? pointInAvatarConservativeBounds(x, y, bounds) : false;
    }

    function hitTestPngtuber(x, y) {
        const manager = window.pngtuberManager;
        const element = manager && (manager.image || manager.imageElement || manager.canvasElement);
        if (!element || !isRendered(element)) return false;
        const rect = element.getBoundingClientRect();
        return pointInRect(x, y, rect);
    }

    function hitTest(xValue, yValue) {
        const x = Number(xValue);
        const y = Number(yValue);
        if (!Number.isFinite(x) || !Number.isFinite(y)) {
            return { interactive: false, component: null, kind: null, id: null };
        }

        const uiRegion = hitTestUi(x, y);
        if (uiRegion) {
            return {
                interactive: true,
                component: uiRegion.component,
                kind: uiRegion.kind,
                id: uiRegion.id
            };
        }

        if (!enabledComponents.has('avatar')) {
            return { interactive: false, component: null, kind: null, id: null };
        }

        if (hitTestLive2D(x, y)) {
            return { interactive: true, component: 'avatar', kind: 'model', id: 'live2d-model' };
        }
        if (hitTestThreeManager(window.vrmManager, x, y)) {
            return { interactive: true, component: 'avatar', kind: 'model', id: 'vrm-model' };
        }
        if (hitTestThreeManager(window.mmdManager, x, y)) {
            return { interactive: true, component: 'avatar', kind: 'model', id: 'mmd-model' };
        }
        if (hitTestPngtuber(x, y)) {
            return { interactive: true, component: 'avatar', kind: 'model', id: 'pngtuber-model' };
        }
        return { interactive: false, component: null, kind: null, id: null };
    }

    function snapshotPointerEvent(event, phase) {
        return {
            phase,
            pointerId: Number(event.pointerId) || 0,
            pointerType: String(event.pointerType || 'mouse'),
            x: Number(event.clientX),
            y: Number(event.clientY),
            buttons: Number(event.buttons) || 0,
            button: Number(event.button),
            isPrimary: event.isPrimary !== false
        };
    }

    function publishPointerRelay(pointer) {
        if (!pointer || !Number.isFinite(pointer.x) || !Number.isFinite(pointer.y)) return;
        postToParent('NEKO_EMBED_POINTER', Object.assign(pointer, hitTestPointerSurface(pointer.x, pointer.y)));
    }

    function hitTestPointerSurface(x, y) {
        const preciseHit = hitTest(x, y);
        if (preciseHit.interactive) return preciseHit;

        // PIXI starts Live2D dragging from the model display object's bounds,
        // which are intentionally broader than configured Cubism hit areas.
        // Match that contract so limbs remain draggable while the rest of the
        // full-screen iframe can still pass through to the host page.
        let live2dRegion = cachedAvatarBoundsRegion?.id === 'live2d-model'
            ? cachedAvatarBoundsRegion
            : null;
        if (!live2dRegion) {
            live2dRegion = getLive2DBoundsRegion();
        }
        if (live2dRegion && pointInRect(x, y, live2dRegion.rect)) {
            return {
                interactive: true,
                component: 'avatar',
                kind: 'model',
                id: 'live2d-model'
            };
        }
        return preciseHit;
    }

    function relayPointerMove(event) {
        pendingPointerRelay = snapshotPointerEvent(event, 'move');
        if (pointerRelayFrame) return;
        pointerRelayFrame = window.requestAnimationFrame(() => {
            pointerRelayFrame = 0;
            const pointer = pendingPointerRelay;
            pendingPointerRelay = null;
            publishPointerRelay(pointer);
        });
    }

    function relayPointerImmediately(event, phase) {
        if (pointerRelayFrame) {
            window.cancelAnimationFrame(pointerRelayFrame);
            pointerRelayFrame = 0;
            pendingPointerRelay = null;
        }
        publishPointerRelay(snapshotPointerEvent(event, phase));
    }

    function postToParent(type, payload) {
        if (window.parent === window) return;
        const targetOrigin = connectedParentOrigin || '*';
        try {
            window.parent.postMessage(Object.assign({
                type,
                protocolVersion: PROTOCOL_VERSION,
                _sender: 'neko-embedded-surface'
            }, payload || {}), targetOrigin);
        } catch (_) {}
    }

    function postReady(requestId) {
        postToParent('NEKO_EMBED_READY', {
            requestId: requestId || null,
            components: componentList(),
            state: componentState(),
            chatMode: fixedChatMode,
            currentChatMode: getCurrentChatMode(),
            avatarForm: detectAvatarFormState().avatarForm,
            capabilities: {
                dynamicComponents: true,
                fixedChatMode: true,
                avatarFormControl: true,
                interactiveRegions: true,
                modelHitTest: true,
                pointerRelay: true
            }
        });
        reportRegions(true);
    }

    function onParentMessage(event) {
        if (event.source !== window.parent || !event.data || typeof event.data.type !== 'string') return;
        const data = event.data;
        if (!data.type.startsWith('NEKO_EMBED_')) return;

        if (connectedParentOrigin && event.origin !== connectedParentOrigin) return;
        if (!connectedParentOrigin) connectedParentOrigin = event.origin;

        if (data.type === 'NEKO_EMBED_CONNECT') {
            if (data.components !== undefined) setComponents(data.components, 'parent-connect');
            if (data.chatMode !== undefined) setFixedChatMode(data.chatMode, 'parent-connect');
            if (data.avatarForm !== undefined) {
                requestAvatarForm(data.avatarForm, data.avatarFormRequestId, 'parent-connect');
            }
            postReady(data.requestId);
            return;
        }

        if (data.type === 'NEKO_EMBED_SET_COMPONENTS') {
            const detail = setComponents(data.components, 'parent-message');
            postToParent('NEKO_EMBED_STATE', Object.assign({ requestId: data.requestId || null }, detail));
            return;
        }

        if (data.type === 'NEKO_EMBED_SET_COMPONENT') {
            const detail = setComponentEnabled(data.component, data.enabled !== false, 'parent-message');
            postToParent('NEKO_EMBED_STATE', Object.assign({
                requestId: data.requestId || null,
                ok: Boolean(detail)
            }, detail || { components: componentList(), state: componentState() }));
            return;
        }

        if (data.type === 'NEKO_EMBED_SET_CHAT_MODE') {
            const detail = setFixedChatMode(data.chatMode, 'parent-message');
            postToParent('NEKO_EMBED_CHAT_MODE_STATE', Object.assign({
                requestId: data.requestId || null
            }, detail));
            return;
        }

        if (data.type === 'NEKO_EMBED_SET_AVATAR_FORM') {
            requestAvatarForm(data.avatarForm, data.avatarFormRequestId || data.requestId, 'parent-message');
            return;
        }

        if (data.type === 'NEKO_EMBED_GET_STATE') {
            postToParent('NEKO_EMBED_STATE', {
                requestId: data.requestId || null,
                components: componentList(),
                state: componentState(),
                chatMode: fixedChatMode,
                currentChatMode: getCurrentChatMode(),
                avatarForm: detectAvatarFormState().avatarForm
            });
            return;
        }

        if (data.type === 'NEKO_EMBED_GET_REGIONS') {
            const regions = collectRegions();
            lastRegionSignature = JSON.stringify(regions);
            postToParent('NEKO_EMBED_INTERACTIVE_REGIONS', {
                requestId: data.requestId || null,
                components: componentList(),
                regions,
                viewport: {
                    width: window.innerWidth,
                    height: window.innerHeight,
                    devicePixelRatio: window.devicePixelRatio || 1
                }
            });
            return;
        }

        if (data.type === 'NEKO_EMBED_HIT_TEST') {
            postToParent('NEKO_EMBED_HIT_TEST_RESULT', Object.assign({
                requestId: data.requestId || null,
                x: Number(data.x),
                y: Number(data.y)
            }, hitTest(data.x, data.y)));
        }
    }

    const api = {
        getComponents: () => componentList(),
        getState: () => componentState(),
        setComponents: (components) => setComponents(components, 'public-api'),
        enable: (component) => setComponentEnabled(component, true, 'public-api'),
        disable: (component) => setComponentEnabled(component, false, 'public-api'),
        toggle: (component) => toggleComponent(component, 'public-api'),
        getChatMode: () => fixedChatMode,
        setChatMode: (mode) => setFixedChatMode(mode, 'public-api'),
        getInteractiveRegions: () => collectRegions(),
        hitTest: (x, y) => hitTest(x, y),
        protocolVersion: PROTOCOL_VERSION
    };
    window.NekoEmbeddedSurface = Object.freeze(api);

    window.addEventListener('message', onParentMessage);
    window.addEventListener('live2d-goodbye-click', (event) => {
        const detail = event && event.detail && typeof event.detail === 'object' ? event.detail : {};
        requestAvatarForm('cat', detail.avatarFormRequestId, 'host-event');
        scheduleAvatarFormSync(0, 'host-event');
    });
    [
        'live2d-return-click',
        'vrm-return-click',
        'mmd-return-click',
        'pngtuber-return-click'
    ].forEach((eventName) => {
        window.addEventListener(eventName, () => {
            requestAvatarForm('model', null, 'host-event');
            scheduleAvatarFormSync(100, 'host-event');
            scheduleResponsiveViewportSync();
        });
    });
    window.addEventListener('resize', () => {
        scheduleResponsiveViewportSync();
        scheduleChatVisibilityCheck();
        scheduleRegionReport();
    });
    window.addEventListener('scroll', scheduleRegionReport, true);
    window.addEventListener('pointermove', (event) => {
        relayPointerMove(event);
        schedulePointerRegionRefresh();
    }, { passive: true, capture: true });
    window.addEventListener('pointerdown', (event) => {
        relayPointerImmediately(event, 'down');
    }, { passive: true, capture: true });
    window.addEventListener('pointerup', (event) => {
        relayPointerImmediately(event, 'up');
        scheduleRegionReport();
    }, { passive: true, capture: true });
    window.addEventListener('pointercancel', (event) => {
        relayPointerImmediately(event, 'cancel');
        scheduleRegionReport();
    }, { passive: true, capture: true });
    document.addEventListener('pointerleave', (event) => {
        relayPointerImmediately(event, 'leave');
        scheduleRegionReport();
    }, { passive: true, capture: true });
    window.addEventListener('wheel', scheduleRegionReport, { passive: true });
    window.addEventListener('chat-surface-mode-change', (event) => {
        const mode = event && event.detail ? String(event.detail.mode || '').trim().toLowerCase() : '';
        if (fixedChatMode === 'auto') {
            rememberPageChatMode(mode);
        } else if (mode !== fixedChatMode) {
            window.requestAnimationFrame(syncFixedChatMode);
        }
        scheduleChatVisibilityCheck();
        scheduleRegionReport();
    });
    [
        'live2d-model-loaded',
        'vrm-model-loaded',
        'mmd-model-loaded',
        'pngtuber-model-loaded',
        'live2d-floating-buttons-ready',
        'neko-avatar-reaction-bubble-setting-changed'
    ].forEach((eventName) => {
        window.addEventListener(eventName, () => {
            syncAvatarRendering();
            scheduleAvatarFormSync(0, 'host-event');
            scheduleResponsiveViewportSync();
            scheduleRegionReport();
        });
    });

    const observer = new MutationObserver(() => {
        scheduleAvatarFormSync(0, 'host-observer');
        scheduleRegionReport();
    });
    observer.observe(document.body || document.documentElement, {
        attributes: true,
        attributeFilter: [
            'class',
            'style',
            'hidden',
            'data-chat-surface-mode',
            'data-choice-layer-open',
            'data-compact-choice-placement',
            'data-subtitle-danmaku-active',
            'data-subtitle-panel-state',
            'data-subtitle-interaction-passthrough'
        ],
        childList: true,
        subtree: true
    });

    const managerSyncInterval = window.setInterval(() => {
        syncAvatarRendering();
        scheduleAvatarFormSync(0, 'host-observer');
        syncFixedChatMode();
        if (chatVisibilityPending) scheduleChatVisibilityCheck();
        scheduleRegionReport();
        managerSyncTicks += 1;
        if (managerSyncTicks >= 80) window.clearInterval(managerSyncInterval);
    }, 250);

    applyComponentState('initial');
    syncFixedChatMode();
    scheduleChatVisibilityCheck();
    scheduleAvatarFormSync(0, 'initial');
    postReady(null);
})();
