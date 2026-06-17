let token = localStorage.getItem('fb_token') || '';
let ws = null;
let selectedPC = null;
let currentPath = '';
let clients = {};
let currentItems = [];
let selectedFiles = new Set();
let pendingDownloads = {};
let pendingUploads = {};
let liveStreamId = null;
let liveFitMode = 'fit';
let lastFrameAt = 0;
let liveControlUnlocked = false;
let livePaused = false;
let liveDragging = false;
let liveMouseDownSent = false;
let liveStartPoint = null;
let livePointerButton = 'left';
let liveLongPressTimer = null;
let liveFrameMeta = { width: 0, height: 0, monitor: { x: 0, y: 0, width: 0, height: 0 } };
let liveStats = { frames: 0, bytes: 0, fps: 0, bitrate: 0, lastStatsAt: 0, lastAdaptiveAt: 0 };
let livePingTimer = null;
let commandSentAt = {};
let audioContext = null;
let terminalHistory = [];
let terminalHistoryIndex = 0;
let screenshots = [];
let recentPaths = JSON.parse(localStorage.getItem('fb_recent_paths') || '[]').slice(0, 10);
let screenshotQuality = 30;
let audioEnabled = false;
let isStreaming = false;

// ---- Mode ----
let appMode = localStorage.getItem('fb_mode') || 'spy';        // 'spy' | 'normal'
let spyBandwidthKbps = Number(localStorage.getItem('fb_spy_bw') || '50');

const SPY_STREAM_PRESET = { quality: 10, fps: 1, resolution: 0.2 };
const SPY_SCREENSHOT_QUALITY = 20;

const STREAM_PRESETS = {
    eco: { quality: 25, fps: 6, resolution: 0.45 },
    balanced: { quality: 45, fps: 10, resolution: 0.6 },
    hd: { quality: 75, fps: 18, resolution: 0.85 }
};

const QUICK_PATHS = {
    windows: {
        desktop: ['%USERPROFILE%\\Desktop', 'C:\\Users\\Public\\Desktop'],
        downloads: ['%USERPROFILE%\\Downloads', 'C:\\Users\\Public\\Downloads'],
        documents: ['%USERPROFILE%\\Documents', 'C:\\Users\\Public\\Documents'],
        pictures: ['%USERPROFILE%\\Pictures', 'C:\\Users\\Public\\Pictures'],
        home: ['%USERPROFILE%', 'C:\\Users'],
        recent: null
    },
    default: {
        desktop: ['~/Desktop', '/home/*/Desktop'],
        downloads: ['~/Downloads', '/home/*/Downloads'],
        documents: ['~/Documents', '/home/*/Documents'],
        pictures: ['~/Pictures', '/home/*/Pictures'],
        home: ['~', '/home'],
        recent: null
    }
};

const textExts = ['txt', 'md', 'log', 'json', 'js', 'ts', 'css', 'html', 'py', 'bat', 'cmd', 'ini', 'conf', 'xml', 'csv', 'yml', 'yaml'];
const imageExts = ['jpg', 'jpeg', 'png', 'gif', 'bmp', 'svg', 'webp'];

// ============================================================
// MODE — SPY / NORMAL
// ============================================================

function setAppMode(mode) {
    appMode = mode;
    localStorage.setItem('fb_mode', mode);
    applyModeToUi();
    if (mode === 'spy' && isStreaming) applySpyParamsToStream();
}

function setSpyBandwidth(kbps) {
    spyBandwidthKbps = Math.max(10, Math.min(10000, Number(kbps) || 50));
    localStorage.setItem('fb_spy_bw', String(spyBandwidthKbps));
    if (appMode === 'spy' && isStreaming) applySpyParamsToStream();
}

function applyModeToUi() {
    const isSpy = appMode === 'spy';
    document.body.classList.toggle('spy-mode', isSpy);

    const spyBtn = $('modeSpyBtn');
    const normalBtn = $('modeNormalBtn');
    if (spyBtn) spyBtn.classList.toggle('active', isSpy);
    if (normalBtn) normalBtn.classList.toggle('active', !isSpy);

    const bwRow = $('bwLimitRow');
    if (bwRow) bwRow.style.display = isSpy ? 'flex' : 'none';

    const bwMeter = $('bwMeter');
    if (bwMeter) bwMeter.style.display = isSpy ? 'flex' : 'none';

    const modeLabel = $('modeLabel');
    if (modeLabel) {
        modeLabel.textContent = isSpy ? 'SPY' : 'NORMAL';
        modeLabel.className = 'mode-label ' + appMode;
    }

    updateBwMeter(liveStats.bitrate || 0);
}

function updateBwMeter(currentKbps) {
    if (appMode !== 'spy') return;
    const bar = $('bwMeterBar');
    const label = $('bwMeterLabel');
    if (!bar || !label) return;
    const pct = Math.min(100, Math.round((currentKbps / spyBandwidthKbps) * 100));
    bar.style.width = pct + '%';
    bar.className = 'bw-meter-bar' + (pct > 90 ? ' over' : pct > 70 ? ' warn' : '');
    label.textContent = currentKbps + ' / ' + spyBandwidthKbps + ' kbps';
}

function applySpyParamsToStream() {
    if (!liveStreamId || !isStreaming) return;
    sendCommand('adjust_stream', {
        streamId: liveStreamId,
        quality: SPY_STREAM_PRESET.quality,
        fps: SPY_STREAM_PRESET.fps,
        resolution: SPY_STREAM_PRESET.resolution
    });
    $('streamQuality').value = SPY_STREAM_PRESET.quality;
    $('streamFps').value = SPY_STREAM_PRESET.fps;
    $('streamResolution').value = SPY_STREAM_PRESET.resolution;
}

function adaptiveSpyThrottle(currentKbps) {
    if (appMode !== 'spy' || !isStreaming || !liveStreamId) return;
    const now = performance.now();
    if (now - liveStats.lastAdaptiveAt < 3000) return;
    liveStats.lastAdaptiveAt = now;

    const limit = spyBandwidthKbps;
    const q = Number($('streamQuality').value);
    const fps = Number($('streamFps').value);
    const res = Number($('streamResolution').value);

    let newQ = q, newFps = fps, newRes = res;

    if (currentKbps > limit * 1.15) {
        // Over budget — step down aggressively
        if (newFps > 1) newFps = Math.max(1, newFps - 1);
        else if (newQ > 10) newQ = Math.max(10, newQ - 5);
        else if (newRes > 0.2) newRes = Math.max(0.2, Math.round((newRes - 0.05) * 100) / 100);
    } else if (currentKbps < limit * 0.5 && currentKbps > 0) {
        // Well under budget — allow tiny quality increase (stay stealthy)
        if (newQ < 20) newQ = Math.min(20, newQ + 2);
    }

    if (newQ !== q || newFps !== fps || newRes !== res) {
        sendCommand('adjust_stream', { streamId: liveStreamId, quality: newQ, fps: newFps, resolution: newRes });
        $('streamQuality').value = newQ;
        $('streamFps').value = newFps;
        $('streamResolution').value = newRes;
    }
}

function $(id) {
    return document.getElementById(id);
}

function toast(message, type = 'info') {
    addActivity(message, type);
}

function addActivity(message, type = 'info') {
    const log = $('activityLog');
    if (!log) return;
    const element = document.createElement('div');
    element.className = 'activity-item ' + type;
    element.innerHTML = '<strong>' + escHtml(message) + '</strong><span>' + new Date().toLocaleTimeString() + '</span>';
    log.prepend(element);
    while (log.children.length > 40) log.lastChild.remove();
    $('activityMetric').textContent = message;
}

async function doLogin() {
    const password = $('loginPassword').value;
    const error = $('loginError');
    error.textContent = '';
    $('loginButton').disabled = true;

    try {
        const response = await fetch('/api/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ password })
        });
        const data = await response.json();
        if (!response.ok || !data.success) {
            error.textContent = data.error || 'Wrong password';
            return;
        }
        token = data.token;
        localStorage.setItem('fb_token', token);
        enterApp();
    } catch (errorValue) {
        error.textContent = 'Could not reach the server';
    } finally {
        $('loginButton').disabled = false;
    }
}

function doLogout() {
    token = '';
    localStorage.removeItem('fb_token');
    if (ws) ws.close();
    ws = null;
    selectedPC = null;
    if (liveStreamId) {
        liveStreamId = null;
        isStreaming = false;
    }
    $('app').classList.remove('active');
    $('loginScreen').style.display = 'grid';
    renderPCList();
}

function enterApp() {
    $('loginScreen').style.display = 'none';
    $('app').classList.add('active');
    connectWS();
    fetchClients();
    addActivity('Dashboard opened', 'success');
}

async function fetchClients() {
    try {
        const response = await fetch('/api/clients', {
            headers: { Authorization: 'Bearer ' + token }
        });
        if (!response.ok) {
            if (response.status === 401) doLogout();
            return;
        }
        const data = await response.json();
        clients = {};
        (data.clients || []).forEach(client => {
            clients[client.id] = client;
        });
        renderPCList();
    } catch (error) {
        setConnectionStatus('Offline');
    }
}

function connectWS() {
    if (!token) return;
    if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;

    const protocol = location.protocol === 'https:' ? 'wss' : 'ws';
    ws = new WebSocket(protocol + '://' + location.host + '/admin');
    setConnectionStatus('Connecting...');

    ws.onopen = () => {
        ws.send(JSON.stringify({ type: 'auth', token }));
    };

    ws.onmessage = event => {
        const data = JSON.parse(event.data);
        if (data.type === 'auth_success') {
            setConnectionStatus('Connected');
        } else if (data.type === 'auth_failed') {
            doLogout();
        } else if (data.type === 'client_list') {
            clients = {};
            data.clients.forEach(client => {
                clients[client.id] = client;
            });
            renderPCList();
        } else if (data.type === 'client_connected') {
            clients[data.client.id] = { ...data.client, online: true, lastSeen: Date.now() };
            renderPCList();
            toast((data.client.name || 'Device') + ' connected', 'success');
        } else if (data.type === 'client_disconnected') {
            if (clients[data.clientId]) {
                clients[data.clientId].online = false;
                renderPCList();
                toast((clients[data.clientId].name || 'Device') + ' disconnected', 'error');
            }
        } else if (data.type === 'command_result') {
            handleCommandResult(data);
        } else if (data.type === 'command_event') {
            handleCommandEvent(data);
        }
    };

    ws.onclose = () => {
        setConnectionStatus('Reconnecting...');
        setTimeout(connectWS, 2500);
    };

    ws.onerror = () => setConnectionStatus('Connection issue');
}

function setConnectionStatus(text) {
    $('connectionStatus').textContent = text;
}

function handleCommandResult(message) {
    const originalType = message.originalType;
    const data = message.data || {};

    if (originalType === 'list_files') {
        renderFiles(data);
    } else if (originalType === 'list_drives') {
        renderDrives(data);
    } else if (originalType === 'take_screenshot') {
        renderScreenshot(data);
    } else if (originalType === 'execute_command') {
        renderTerminalOutput(data);
    } else if (originalType === 'ping') {
        const latency = commandSentAt[message.requestId] ? Date.now() - commandSentAt[message.requestId] : null;
        if (latency) $('liveResolutionStat').textContent = latency + 'ms';
        toast('Latency: ' + (latency ? latency + 'ms' : (data.latency || 'ok')), 'success');
    } else if (originalType === 'delete_file') {
        data.success ? toast('Deleted successfully', 'success') : toast(data.error || 'Delete failed', 'error');
        if (data.success) refreshFiles();
    } else if (originalType === 'rename_file') {
        data.success ? toast('Renamed successfully', 'success') : toast(data.error || 'Rename failed', 'error');
        if (data.success) refreshFiles();
    } else if (originalType === 'create_folder') {
        data.success ? toast('Folder created', 'success') : toast(data.error || 'Create failed', 'error');
        if (data.success) refreshFiles();
    } else if (originalType === 'download_file') {
        handleDownloadResponse(message.requestId, data);
    } else if (originalType === 'upload_file') {
        data.success ? toast('Upload complete', 'success') : toast(data.error || 'Upload failed', 'error');
        if (data.success) refreshFiles();
    } else if (originalType === 'start_live_stream' || originalType === 'live_stream_response') {
        if (data.status === 'streaming') {
            liveStreamId = data.stream_id || liveStreamId;
            isStreaming = true;
            $('liveStatus').textContent = 'Live stream active.';
            updateStreamButtons(true);
            toast('Live stream started', 'success');
        } else if (data.error) {
            $('liveStatus').textContent = data.error;
            toast(data.error, 'error');
            updateStreamButtons(false);
        }
    } else if (originalType === 'stop_live_stream') {
        isStreaming = false;
        $('liveStatus').textContent = 'Live stream stopped.';
        toast('Live stream stopped', 'info');
        liveStreamId = null;
        updateStreamButtons(false);
        clearLivePreview();
    } else if (originalType === 'adjust_stream') {
        if (data.error) toast(data.error, 'error');
    } else if (originalType === 'get_monitors') {
        renderMonitorOptions(data.monitors || [], data.selected || 0);
    }
    delete commandSentAt[message.requestId];
}

function handleCommandEvent(message) {
    const payload = message.data || {};
    if (message.clientId && selectedPC && message.clientId !== selectedPC) return;

    if (message.eventType === 'command_output') {
        renderTerminalOutput({ stdout: payload.data, stderr: payload.stream === 'stderr' ? payload.data : '' });
        return;
    }

    if (message.eventType === 'command_exit') {
        appendTerminal('Process exited with code: ' + payload.returncode, 'cmd-muted');
        return;
    }

    if (message.eventType === 'stream_frame') {
        if (!livePaused && isStreaming) {
            updateLivePreview(payload.frameData, payload.width, payload.height, payload.frameIndex, payload.monitor);
        }
        return;
    }

    if (message.eventType === 'stream_audio') {
        if (audioEnabled && !livePaused) {
            playAudioChunk(payload);
        }
        return;
    }

    if (message.eventType === 'stream_error') {
        $('liveStatus').textContent = payload.error || 'Stream error';
        toast('Stream error: ' + (payload.error || 'Unknown'), 'error');
        isStreaming = false;
        updateStreamButtons(false);
        return;
    }

    if (message.eventType === 'download_file_chunk') {
        handleDownloadChunk(message.requestId, payload);
        return;
    }

    if (message.eventType === 'download_file_error') {
        toast('Download failed: ' + (payload.error || 'Unknown'), 'error');
        setTransferStatus('Download failed: ' + (payload.error || 'Unknown'), 'error');
        delete pendingDownloads[message.requestId];
        return;
    }

    if (message.eventType === 'upload_file_response') {
        handleUploadEvent(message.requestId, payload);
    }
}

function sendCommand(command, params = {}, requestId = null) {
    if (!selectedPC) {
        toast('Select a device first', 'error');
        return null;
    }
    if (!ws || ws.readyState !== WebSocket.OPEN) {
        toast('Dashboard connection is not ready', 'error');
        return null;
    }

    const id = requestId || params.requestId || 'req_' + Date.now() + '_' + Math.random().toString(16).slice(2);
    ws.send(JSON.stringify({
        clientId: selectedPC,
        command,
        params: { ...params, requestId: id }
    }));
    commandSentAt[id] = Date.now();
    return id;
}

function renderPCList() {
    const query = ($('pcSearch')?.value || '').toLowerCase();
    const ids = Object.keys(clients).filter(id => {
        const client = clients[id];
        const haystack = [client.name, client.hostname, client.ip, id].join(' ').toLowerCase();
        return haystack.includes(query);
    }).sort((a, b) => Number(!!clients[b].online) - Number(!!clients[a].online) || (clients[a].name || '').localeCompare(clients[b].name || ''));

    const online = Object.values(clients).filter(client => client.online).length;
    $('onlineCount').textContent = online;
    $('totalCount').textContent = Object.keys(clients).length;

    if (ids.length === 0) {
        $('pcList').innerHTML = '<div class="drop-target"><strong>No devices connected</strong></div>';
        return;
    }

    $('pcList').innerHTML = ids.map(id => {
        const client = clients[id];
        return '<button class="pc-item ' + (selectedPC === id ? 'active' : '') + '" type="button" data-id="' + escAttr(id) + '">' +
            '<span class="pc-dot ' + (client.online ? '' : 'offline') + '"></span>' +
            '<span><span class="pc-name">' + escHtml(client.name || 'Unknown') + '</span><span class="pc-host">' + escHtml(client.hostname || client.ip || id) + '</span></span>' +
            '<span class="pc-pill">' + (client.online ? 'Online' : 'Offline') + '</span>' +
        '</button>';
    }).join('');

    $('pcList').querySelectorAll('.pc-item').forEach(button => {
        button.addEventListener('click', () => selectPC(button.dataset.id));
    });

    if (selectedPC && clients[selectedPC]) updateSelectedHeader();
}

function selectPC(id) {
    if (isStreaming) {
        stopLiveStream();
    }
    selectedPC = id;
    currentPath = '/';
    currentItems = [];
    selectedFiles.clear();
    $('emptyState').style.display = 'none';
    $('pcContent').style.display = 'flex';
    renderPCList();
    updateSelectedHeader();
    switchTab('files');
    loadFiles('/');
    setTimeout(() => sendCommand('get_monitors'), 250);
    addActivity('Selected ' + (clients[id]?.name || id), 'info');
}

function updateSelectedHeader() {
    const client = clients[selectedPC];
    if (!client) return;
    $('workspaceTitle').textContent = client.name || 'Unknown device';
    $('selectedMetric').textContent = client.hostname || client.ip || selectedPC;
    $('pathMetric').textContent = currentPath || '-';
}

function switchTab(tab) {
    document.querySelectorAll('.tab').forEach(button => button.classList.toggle('active', button.dataset.tab === tab));
    document.querySelectorAll('.tab-content').forEach(panel => panel.classList.toggle('active', panel.id === 'tab-' + tab));

    if (tab === 'info') renderSystemInfo();
    if (tab === 'screenshot') renderScreenshotEmpty();
    if (tab === 'live') {
        if (!$('livePreview').innerHTML.trim()) renderLiveEmpty();
        sendCommand('get_monitors');
    }
}

function loadFiles(pathValue) {
    if (!selectedPC) return;
    currentPath = pathValue || '/';
    selectedFiles.clear();
    updateBulkActions();
    updateSelectedHeader();
    updateManualPathInput();
    $('filesList').innerHTML = '<div class="loading"><div class="spinner"></div><div>Loading files...</div></div>';
    $('filesMeta').textContent = 'Loading ' + currentPath;
    sendCommand('list_files', { path: currentPath });
}

function updateManualPathInput() {
    const input = $('manualPathInput');
    if (input) {
        input.value = currentPath === '/' ? '' : currentPath;
    }
}

function handleManualPathInput() {
    const input = $('manualPathInput');
    const raw = (input.value || '').trim();
    if (raw) {
        const pathValue = expandEnvPath(raw);
        loadFiles(pathValue);
        addToRecentPaths(pathValue);
    }
}

function addToRecentPaths(pathValue) {
    recentPaths = recentPaths.filter(p => p !== pathValue);
    recentPaths.unshift(pathValue);
    recentPaths = recentPaths.slice(0, 10);
    localStorage.setItem('fb_recent_paths', JSON.stringify(recentPaths));
}

function expandEnvPath(pathValue) {
    const client = clients[selectedPC];
    const info = client?.systemInfo || {};
    const username = info.username || '';
    const homedir = info.homedir || info.home || (username ? 'C:\\Users\\' + username : '');

    return pathValue
        .replace(/%USERPROFILE%/gi, homedir || '%USERPROFILE%')
        .replace(/%HOMEDRIVE%%HOMEPATH%/gi, homedir || '%HOMEDRIVE%%HOMEPATH%')
        .replace(/%USERNAME%/gi, username || '%USERNAME%')
        .replace(/^~/, homedir || '~');
}

function handleQuickPath(pathType) {
    if (pathType === 'recent') {
        if (recentPaths.length > 0) {
            showRecentPathsModal();
        } else {
            toast('No recent paths', 'info');
        }
        return;
    }

    const client = clients[selectedPC];
    const platform = client?.systemInfo?.platform?.toLowerCase() || '';
    const isWindows = platform.includes('win');
    const paths = isWindows ? QUICK_PATHS.windows : QUICK_PATHS.default;
    const pathList = paths[pathType];

    if (pathList && pathList.length > 0) {
        const resolved = expandEnvPath(pathList[0]);
        loadFiles(resolved);
    }
}

function showRecentPathsModal() {
    if (recentPaths.length === 0) {
        toast('No recent paths', 'info');
        return;
    }
    showModal('Recent Paths',
        '<div class="recent-paths-list">' +
        recentPaths.map(p => '<button class="tool-button recent-path-item" data-path="' + escAttr(p) + '" type="button">' + escHtml(p) + '</button>').join('') +
        '</div>',
        [{ label: 'Close', action: closeModal }]
    );
    document.querySelectorAll('.recent-path-item').forEach(btn => {
        btn.addEventListener('click', () => {
            loadFiles(btn.dataset.path);
            closeModal();
        });
    });
}

function renderDrives(data) {
    const drives = data.drives || [];
    currentItems = drives.map(drive => ({
        name: drive.path,
        path: drive.path,
        is_dir: true,
        size: drive.free || '',
        modified: drive.total ? drive.used + ' used of ' + drive.total : ''
    }));
    renderPathBar('Drives');
    $('filesMeta').textContent = drives.length + ' drives available.';
    renderFileItems(currentItems, true);
}

function renderFiles(data) {
    if (data.error) {
        $('filesList').innerHTML = '<div class="empty-state"><div class="empty-card"><h2>Could not load files</h2><p>' + escHtml(data.error) + '</p></div></div>';
        return;
    }

    currentPath = data.path || currentPath || '/';
    currentItems = data.items || [];
    renderPathBar(currentPath);
    updateSelectedHeader();
    updateManualPathInput();
    clearTransferStatus();
    $('filesMeta').textContent = currentItems.length + ' item' + (currentItems.length === 1 ? '' : 's') + ' in ' + currentPath;
    renderFileItems(getVisibleItems());
}

function getVisibleItems() {
    const query = ($('fileSearch').value || '').toLowerCase();
    const sort = $('fileSort').value;
    return currentItems
        .filter(item => (item.name || item.path || '').toLowerCase().includes(query))
        .sort((a, b) => {
            if (a.is_dir !== b.is_dir) return a.is_dir ? -1 : 1;
            if (sort === 'type') return getExtension(a.name).localeCompare(getExtension(b.name));
            if (sort === 'size') return parseSizeValue(b.size) - parseSizeValue(a.size);
            if (sort === 'modified') return String(b.modified || '').localeCompare(String(a.modified || ''));
            return String(a.name || '').localeCompare(String(b.name || ''));
        });
}

function renderFileItems(items, driveMode = false) {
    const list = $('filesList');
    list.classList.remove('dragover');

    if (!items.length) {
        list.innerHTML = '<div class="drop-target" id="dropTarget"><strong>This folder is empty.</strong><br>Drop files here or use Upload.</div>';
        wireDropTarget($('dropTarget'));
        return;
    }

    list.innerHTML = items.map(item => fileRowHtml(item, driveMode)).join('');

    list.querySelectorAll('.file-item').forEach(row => {
        const checkbox = row.querySelector('.file-item-checkbox');
        const menuBtn = row.querySelector('.file-menu-btn');

        row.addEventListener('click', event => {
            event.stopPropagation();
            if (event.target === checkbox || event.target.closest('.file-item-checkbox')) {
                toggleFileSelect(row.dataset.path);
                updateBulkActions();
            } else if (!event.target.closest('.file-menu-btn')) {
                openFileRow(row);
            }
        });

        menuBtn.addEventListener('click', event => {
            event.stopPropagation();
            openFileContextMenu(menuBtn, row);
        });
    });

    list.querySelectorAll('[data-action]').forEach(button => {
        button.addEventListener('click', event => {
            event.stopPropagation();
            runFileAction(button.dataset.action, button.closest('.file-item'));
        });
    });

    wireDropTarget(list);
}

function toggleFileSelect(path) {
    if (selectedFiles.has(path)) {
        selectedFiles.delete(path);
        document.querySelector('[data-path="' + escAttr(path) + '"]')?.classList.remove('selected');
    } else {
        selectedFiles.add(path);
        document.querySelector('[data-path="' + escAttr(path) + '"]')?.classList.add('selected');
    }
}

function updateBulkActions() {
    const bulkDelete = $('bulkDeleteButton');
    if (selectedFiles.size > 0) {
        bulkDelete.style.display = 'block';
        bulkDelete.textContent = 'Delete (' + selectedFiles.size + ')';
    } else {
        bulkDelete.style.display = 'none';
    }
}

function getFileEmoji(item) {
    if (item.is_dir) return '📁';
    const ext = getExtension(item.name || item.path || '').toLowerCase();
    const map = {
        'txt': '📄', 'md': '📝', 'log': '📋', 'json': '📋', 'csv': '📊', 'ini': '📋', 'conf': '📋',
        'js': '⚙️', 'ts': '⚙️', 'py': '🐍', 'html': '🌐', 'css': '🎨', 'xml': '📋', 'yml': '📋', 'yaml': '📋',
        'png': '🖼️', 'jpg': '🖼️', 'jpeg': '🖼️', 'gif': '🖼️', 'bmp': '🖼️', 'svg': '🖼️', 'webp': '🖼️',
        'mp3': '🎵', 'wav': '🎵', 'flac': '🎵', 'ogg': '🎵',
        'mp4': '🎬', 'mov': '🎬', 'mkv': '🎬', 'avi': '🎬', 'wmv': '🎬',
        'zip': '📦', 'rar': '📦', '7z': '📦', 'gz': '📦', 'tar': '📦',
        'exe': '⚡', 'msi': '⚡', 'bat': '⚡', 'cmd': '⚡', 'sh': '⚡',
        'pdf': '📕', 'doc': '📘', 'docx': '📘', 'ppt': '📙', 'pptx': '📙', 'xls': '📗', 'xlsx': '📗',
        'sql': '🗄️', 'db': '🗄️', 'sqlite': '🗄️',
        'psd': '🖌️', 'ai': '🖌️', 'fig': '🖌️',
        'apk': '📱', 'iso': '💿',
    };
    return map[ext] || '📄';
}

function fileRowHtml(item, driveMode) {
    const name = item.name || item.path || 'Untitled';
    const extension = getExtension(name);
    const kind = item.is_dir ? 'Folder' : extension.toUpperCase() || 'File';
    const isSelected = selectedFiles.has(item.path);
    return '<div class="file-item' + (isSelected ? ' selected' : '') + '" data-path="' + escAttr(item.path || name) + '" data-name="' + escAttr(name) + '" data-ext="' + escAttr(extension) + '" data-dir="' + (item.is_dir ? '1' : '0') + '" data-drive="' + (driveMode ? '1' : '0') + '">' +
        '<div class="file-item-checkbox"></div>' +
        '<div class="file-main"><span class="file-icon emoji-icon">' + getFileEmoji(item) + '</span><span class="file-text"><span class="file-name">' + escHtml(name) + '</span><span class="file-sub">' + escHtml(kind) + '</span></span></div>' +
        '<button class="file-menu-btn" type="button" title="More options" tabindex="-1">&#8943;</button>' +
    '</div>';
}

function openFileRow(row) {
    if (row.dataset.dir === '1') {
        const pathValue = row.dataset.path;
        loadFiles(pathValue);
        addToRecentPaths(pathValue);
    } else {
        openFile(row.dataset.path, row.dataset.name, row.dataset.ext);
    }
}

function runFileAction(action, row) {
    if (!row) return;
    const pathValue = row.dataset.path;
    const name = row.dataset.name;
    const extension = row.dataset.ext;

    if (action === 'open') {
        loadFiles(pathValue);
        addToRecentPaths(pathValue);
    }
    if (action === 'open-file') openFile(pathValue, name, extension);
    if (action === 'download') downloadFile(pathValue, name);
    if (action === 'rename') showRenameModal(pathValue, name);
    if (action === 'delete') deleteFile(pathValue);
}

function openFileContextMenu(trigger, row) {
    closeFileContextMenu();

    const isDir = row.dataset.dir === '1';
    const isDrive = row.dataset.drive === '1';

    const actions = [];
    if (isDir || isDrive) {
        actions.push({ label: 'Open', action: isDir ? 'open' : 'open' });
    } else {
        actions.push({ label: 'Preview', action: 'open-file' });
        actions.push({ label: 'Download', action: 'download' });
        actions.push({ label: 'Rename', action: 'rename' });
    }
    if (!isDrive) {
        actions.push({ label: 'Delete', action: 'delete', danger: true });
    }

    const menu = document.createElement('div');
    menu.id = 'fileContextMenu';
    menu.className = 'file-context-menu';
    menu.innerHTML = actions.map(a =>
        '<button class="file-ctx-item' + (a.danger ? ' danger' : '') + '" data-action="' + escAttr(a.action) + '" type="button">' + escHtml(a.label) + '</button>'
    ).join('');

    menu.querySelectorAll('[data-action]').forEach(btn => {
        btn.addEventListener('click', event => {
            event.stopPropagation();
            closeFileContextMenu();
            runFileAction(btn.dataset.action, row);
        });
    });

    document.body.appendChild(menu);

    const rect = trigger.getBoundingClientRect();
    const menuW = 140;
    let left = rect.right - menuW;
    let top = rect.bottom + 4;
    if (left < 8) left = 8;
    if (top + 160 > window.innerHeight) top = rect.top - 4 - (actions.length * 38);
    menu.style.left = left + 'px';
    menu.style.top = top + 'px';

    requestAnimationFrame(() => {
        document.addEventListener('click', closeFileContextMenu, { once: true });
        document.addEventListener('keydown', onContextMenuKey);
    });
}

function onContextMenuKey(event) {
    if (event.key === 'Escape') closeFileContextMenu();
}

function closeFileContextMenu() {
    const menu = document.getElementById('fileContextMenu');
    if (menu) menu.remove();
    document.removeEventListener('keydown', onContextMenuKey);
}

function renderPathBar(pathValue) {
    const bar = $('pathBar');
    if (!pathValue || pathValue === '/') {
        bar.innerHTML = '<button type="button" data-path="/">Root</button>';
    } else if (pathValue === 'Drives') {
        bar.innerHTML = '<button type="button" data-path="">Drives</button>';
    } else {
        const normalized = pathValue.replace(/\\/g, '/');
        const parts = normalized.split('/').filter(Boolean);
        let built = normalized.startsWith('/') ? '/' : '';
        let html = '<button type="button" data-path="/">Root</button>';
        parts.forEach(part => {
            built = built === '/' ? '/' + part : built + (built.endsWith('/') ? '' : '/') + part;
            html += '<span class="path-sep">/</span><button type="button" data-path="' + escAttr(built) + '">' + escHtml(part) + '</button>';
        });
        bar.innerHTML = html;
    }

    bar.querySelectorAll('button[data-path]').forEach(button => {
        button.addEventListener('click', () => {
            if (button.dataset.path) loadFiles(button.dataset.path);
        });
    });
}

function goUp() {
    if (!currentPath || currentPath === '/') return;
    const normalized = currentPath.replace(/\\/g, '/').replace(/\/$/, '');
    const parts = normalized.split('/');
    parts.pop();
    loadFiles(parts.join('/') || '/');
}

function refreshFiles() {
    loadFiles(currentPath || '/');
}

function loadDrives() {
    $('filesMeta').textContent = 'Loading drives...';
    $('filesList').innerHTML = '<div class="loading"><div class="spinner"></div><div>Loading drives...</div></div>';
    sendCommand('list_drives');
}

function openFile(pathValue, name, extension) {
    if (textExts.includes(extension)) {
        editTextFile(pathValue, name);
    } else if (imageExts.includes(extension)) {
        previewImageFile(pathValue, name);
    } else {
        downloadFile(pathValue, name);
    }
}

function editTextFile(pathValue, name) {
    const requestId = sendCommand('download_file', { path: pathValue, chunk_size: 256 * 1024 });
    if (!requestId) return;
    pendingDownloads[requestId] = { name, path: pathValue, preview: 'text', chunks: [], received: 0, size: 0 };
    setTransferStatus('Loading text preview for ' + name, 'info');
}

function previewImageFile(pathValue, name) {
    const requestId = sendCommand('download_file', { path: pathValue, chunk_size: 512 * 1024 });
    if (!requestId) return;
    pendingDownloads[requestId] = { name, path: pathValue, preview: 'image', chunks: [], received: 0, size: 0 };
    setTransferStatus('Loading image preview for ' + name, 'info');
}

function downloadFile(pathValue, name) {
    const requestId = sendCommand('download_file', { path: pathValue, chunk_size: 512 * 1024 });
    if (!requestId) return;
    pendingDownloads[requestId] = { name: name || fileNameFromPath(pathValue), path: pathValue, chunks: [], received: 0, size: 0 };
    setTransferStatus('Starting download: ' + (name || fileNameFromPath(pathValue)), 'info');
}

function handleDownloadResponse(requestId, data) {
    if (data.content) {
        const transfer = pendingDownloads[requestId];
        const blob = new Blob([base64ToUint8Array(data.content)]);
        if (transfer?.preview === 'text') {
            const reader = new FileReader();
            reader.onload = () => showTextEditor(transfer.path, transfer.name, reader.result);
            reader.readAsText(blob);
            setTransferStatus('Preview ready: ' + transfer.name, 'success');
        } else if (transfer?.preview === 'image') {
            showImageModal(transfer.name, URL.createObjectURL(blob));
            setTransferStatus('Preview ready: ' + transfer.name, 'success');
        } else {
            saveBlob(blob, data.name || transfer?.name || 'download');
            toast('Download started', 'success');
        }
        delete pendingDownloads[requestId];
        return;
    }

    if (data.status === 'streaming') {
        pendingDownloads[requestId] = {
            ...(pendingDownloads[requestId] || {}),
            name: data.name || pendingDownloads[requestId]?.name || 'download',
            path: data.path || pendingDownloads[requestId]?.path || '',
            size: data.size || 0,
            chunks: [],
            received: 0
        };
        setTransferStatus('Streaming download: ' + pendingDownloads[requestId].name, 'info');
        return;
    }

    if (data.error) toast(data.error, 'error');
}

function handleDownloadChunk(requestId, payload) {
    const transfer = pendingDownloads[requestId];
    if (!transfer) return;

    if (payload.size) transfer.size = payload.size;
    if (payload.chunk) {
        const index = typeof payload.chunk_index === 'number' ? payload.chunk_index : transfer.received;
        transfer.chunks[index] = base64ToUint8Array(payload.chunk);
        transfer.received += 1;
    }

    if (transfer.size) {
        const chunkSize = 512 * 1024;
        const totalChunks = Math.max(1, Math.ceil(transfer.size / chunkSize));
        const percent = Math.min(100, Math.round((transfer.received / totalChunks) * 100));
        setTransferStatus('Downloading ' + transfer.name + ' - ' + percent + '%', 'info');
    }

    if (payload.is_last) {
        const blob = new Blob(transfer.chunks);
        if (transfer.preview === 'text') {
            const reader = new FileReader();
            reader.onload = () => showTextEditor(transfer.path, transfer.name, reader.result);
            reader.readAsText(blob);
            setTransferStatus('Preview ready: ' + transfer.name, 'success');
        } else if (transfer.preview === 'image') {
            showImageModal(transfer.name, URL.createObjectURL(blob));
            setTransferStatus('Preview ready: ' + transfer.name, 'success');
        } else {
            saveBlob(blob, transfer.name);
            toast('Download complete: ' + transfer.name, 'success');
            setTransferStatus('Download complete: ' + transfer.name, 'success');
        }
        delete pendingDownloads[requestId];
    }
}

function saveBlob(blobOrBytes, name) {
    const blob = blobOrBytes instanceof Blob ? blobOrBytes : new Blob([blobOrBytes]);
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = name;
    link.click();
    URL.revokeObjectURL(url);
}

function showTextEditor(pathValue, name, content) {
    showModal('Edit ' + name,
        '<textarea id="previewTextArea" style="height:300px;">' + escHtml(content) + '</textarea>',
        [
            { label: 'Cancel', action: closeModal },
            { label: 'Save', primary: true, action: () => saveTextFile(pathValue, name, $('previewTextArea').value) }
        ]
    );
}

function showImageModal(name, blobUrl) {
    showModal(name,
        '<div class="preview-shell"><img class="preview-image" src="' + escAttr(blobUrl) + '" alt="' + escAttr(name) + '"></div>',
        [
            { label: 'Close', action: closeModal },
            { label: 'Open full size', primary: true, action: () => window.open(blobUrl, '_blank') }
        ]
    );
}

function saveTextFile(pathValue, name, content) {
    const dirPath = pathValue.replace(/\\/g, '/').replace(/\/[^/]+$/, '') || '/';
    uploadBytes(new TextEncoder().encode(content), name, dirPath, 256 * 1024);
    closeModal();
}

async function handleUpload(files) {
    for (const file of files) {
        try {
            const buffer = await readFileAsArrayBuffer(file);
            uploadBytes(new Uint8Array(buffer), file.name, currentPath || '/', 512 * 1024);
        } catch (error) {
            toast('Upload failed: ' + error.message, 'error');
        }
    }
}

function uploadBytes(bytes, name, pathValue, chunkSize) {
    const requestId = 'up_' + Date.now() + '_' + Math.random().toString(16).slice(2);
    const totalChunks = Math.max(1, Math.ceil(bytes.length / chunkSize));
    pendingUploads[requestId] = { name, total: bytes.length, sent: 0, path: pathValue };

    for (let index = 0; index < totalChunks; index++) {
        const start = index * chunkSize;
        const end = Math.min(bytes.length, start + chunkSize);
        sendCommand('upload_file', {
            path: pathValue,
            name,
            content: arrayBufferToBase64(bytes.slice(start, end)),
            chunk_index: index,
            is_last: index === totalChunks - 1
        }, requestId);
        pendingUploads[requestId].sent = end;
    }

    toast('Upload queued: ' + name, 'success');
    setTransferStatus('Uploading ' + name + '...', 'info');
}

function handleUploadEvent(requestId, payload) {
    const state = pendingUploads[requestId];
    if (payload.success && state) {
        if (payload.is_last) {
            toast('Upload complete: ' + state.name, 'success');
            setTransferStatus('Upload complete: ' + state.name, 'success');
            delete pendingUploads[requestId];
            refreshFiles();
        } else {
            setTransferStatus('Uploading ' + state.name + ' - chunk ' + ((payload.chunk_index || 0) + 1), 'info');
        }
    } else if (payload.error) {
        toast('Upload error: ' + payload.error, 'error');
        setTransferStatus('Upload error: ' + payload.error, 'error');
        delete pendingUploads[requestId];
    }
}

function deleteFile(pathValue) {
    if (!confirm('Delete this file or folder? This cannot be undone from the dashboard.')) return;
    sendCommand('delete_file', { path: pathValue });
}

function showRenameModal(oldPath, oldName) {
    showModal('Rename item',
        '<label class="field-label" for="renameInput">New name</label><input id="renameInput" value="' + escAttr(oldName) + '">',
        [
            { label: 'Cancel', action: closeModal },
            { label: 'Rename', primary: true, action: () => {
                const newName = $('renameInput').value.trim();
                if (newName && newName !== oldName) sendCommand('rename_file', { oldPath, newName });
                closeModal();
            }}
        ]
    );
}

function showNewFolderModal() {
    showModal('New folder',
        '<label class="field-label" for="newFolderInput">Folder name</label><input id="newFolderInput" placeholder="Project files">',
        [
            { label: 'Cancel', action: closeModal },
            { label: 'Create', primary: true, action: () => {
                const name = $('newFolderInput').value.trim();
                if (name) sendCommand('create_folder', { path: joinPath(currentPath, name) });
                closeModal();
            }}
        ]
    );
}

function takeScreenshot() {
    $('screenshotContainer').innerHTML = '<div class="loading"><div class="spinner"></div><div>Capturing screen...</div></div>';
    const quality = appMode === 'spy' ? SPY_SCREENSHOT_QUALITY : screenshotQuality;
    sendCommand('take_screenshot', { quality });
}

function renderScreenshotEmpty() {
    if (screenshots.length > 0) return;
    $('screenshotContainer').innerHTML = '<div class="screenshot-empty"><div class="empty-icon">IMG</div><h2>No screenshots yet</h2><p>Click Capture to take a screenshot from the selected device.</p></div>';
}

function renderScreenshot(data) {
    if (data.error) {
        toast('Screenshot failed: ' + data.error, 'error');
        if (screenshots.length === 0) renderScreenshotEmpty();
        return;
    }
    const entry = {
        src: 'data:image/' + (data.format || 'png') + ';base64,' + data.screenshot,
        format: data.format || 'png',
        time: new Date().toLocaleTimeString(),
        ts: Date.now()
    };
    screenshots.unshift(entry);
    renderScreenshotGallery();
}

function renderScreenshotGallery() {
    const container = $('screenshotContainer');
    if (screenshots.length === 0) {
        renderScreenshotEmpty();
        return;
    }
    const html = '<div class="screenshot-gallery">' +
        screenshots.map((shot, index) =>
            '<div class="screenshot-thumb" data-index="' + index + '">' +
            '<img src="' + escAttr(shot.src) + '" alt="Screenshot ' + escAttr(shot.time) + '">' +
            '<div class="screenshot-thumb-footer">' +
            '<span class="screenshot-thumb-time">' + escHtml(shot.time) + '</span>' +
            '<button class="screenshot-thumb-save" data-index="' + index + '" type="button">Save</button>' +
            '</div></div>'
        ).join('') +
    '</div>';
    container.innerHTML = html;

    container.querySelectorAll('.screenshot-thumb img').forEach(img => {
        img.parentElement.addEventListener('click', event => {
            if (event.target.classList.contains('screenshot-thumb-save')) return;
            const index = Number(img.parentElement.dataset.index);
            openScreenshotZoom(index);
        });
    });

    container.querySelectorAll('.screenshot-thumb-save').forEach(btn => {
        btn.addEventListener('click', event => {
            event.stopPropagation();
            const shot = screenshots[Number(btn.dataset.index)];
            if (!shot) return;
            const link = document.createElement('a');
            link.href = shot.src;
            link.download = 'screenshot_' + shot.ts + '.' + shot.format;
            link.click();
        });
    });
}

function openScreenshotZoom(index) {
    const shot = screenshots[index];
    if (!shot) return;

    const overlay = document.createElement('div');
    overlay.className = 'screenshot-zoom-overlay';

    const img = document.createElement('img');
    img.src = shot.src;
    img.alt = 'Screenshot ' + shot.time;
    img.addEventListener('click', event => event.stopPropagation());

    const close = document.createElement('button');
    close.className = 'screenshot-zoom-close';
    close.textContent = '×';
    close.title = 'Close';

    overlay.appendChild(img);
    overlay.appendChild(close);
    document.body.appendChild(overlay);

    const dismiss = () => overlay.remove();
    overlay.addEventListener('click', dismiss);
    close.addEventListener('click', dismiss);

    const onKey = event => {
        if (event.key === 'Escape') { dismiss(); document.removeEventListener('keydown', onKey); }
        if (event.key === 'ArrowLeft' && index > 0) { dismiss(); document.removeEventListener('keydown', onKey); openScreenshotZoom(index - 1); }
        if (event.key === 'ArrowRight' && index < screenshots.length - 1) { dismiss(); document.removeEventListener('keydown', onKey); openScreenshotZoom(index + 1); }
    };
    document.addEventListener('keydown', onKey);
}

function clearScreenshots() {
    screenshots = [];
    renderScreenshotEmpty();
}

function downloadScreenshot() {
    if (screenshots.length === 0) return;
    const shot = screenshots[0];
    const link = document.createElement('a');
    link.href = shot.src;
    link.download = 'screenshot_' + shot.ts + '.' + shot.format;
    link.click();
}

function setStreamQualityPreset(preset) {
    const settings = STREAM_PRESETS[preset];
    if (!settings) return;

    $('streamQuality').value = settings.quality;
    $('streamFps').value = settings.fps;
    $('streamResolution').value = settings.resolution;

    document.querySelectorAll('.quality-preset.live-preset').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.preset === preset);
    });

    if (isStreaming && liveStreamId) {
        sendCommand('adjust_stream', {
            streamId: liveStreamId,
            quality: settings.quality,
            fps: settings.fps,
            resolution: settings.resolution
        });
    }

    toast(preset.charAt(0).toUpperCase() + preset.slice(1) + ' mode', 'info');
}

function startLiveStream() {
    if (isStreaming) {
        toast('Stream already running', 'error');
        return;
    }

    liveStreamId = 'live_' + Date.now();
    livePaused = false;
    isStreaming = true;
    resetLiveStats();
    ensureLiveStage();

    let quality = Number($('streamQuality').value) || 35;
    let fps = Number($('streamFps').value) || 8;
    let resolution = Number($('streamResolution').value) || 0.5;
    const monitor = Number($('streamMonitor').value) || 0;

    if (appMode === 'spy') {
        quality = SPY_STREAM_PRESET.quality;
        fps = SPY_STREAM_PRESET.fps;
        resolution = SPY_STREAM_PRESET.resolution;
        $('streamQuality').value = quality;
        $('streamFps').value = fps;
        $('streamResolution').value = resolution;
    }

    sendCommand('start_live_stream', {
        streamId: liveStreamId,
        quality,
        fps,
        resolution,
        monitor,
        audio: audioEnabled
    });

    $('liveStatus').textContent = 'Starting live stream...';
    updateStreamButtons(true);
    startLivePing();
}

function stopLiveStream() {
    if (!liveStreamId && !isStreaming) {
        toast('No active stream', 'error');
        return;
    }

    if (liveStreamId) {
        sendCommand('stop_live_stream', { streamId: liveStreamId });
    }

    liveStreamId = null;
    isStreaming = false;
    livePaused = false;
    stopLivePing();
    clearLivePreview();
    updateStreamButtons(false);
    $('liveStatus').textContent = 'Click "Start Stream" to begin.';
}

function updateStreamButtons(streaming) {
    $('startStreamButton').style.display = streaming ? 'none' : 'inline-flex';
    $('stopStreamButton').style.display = streaming ? 'inline-flex' : 'none';
    $('pauseStreamButton').disabled = !streaming;
    $('fitStreamButton').disabled = !streaming;
    $('fullStreamButton').disabled = !streaming;
    $('controlLockButton').disabled = !streaming;
}

function clearLivePreview() {
    const preview = $('livePreview');
    if (preview) {
        preview.innerHTML = '';
    }
}

function renderLiveEmpty() {
    $('livePreview').innerHTML = '<div class="empty-card"><div class="empty-icon">LIVE</div><h2>Live preview</h2><p>Start a stream to watch the remote screen. Use Eco mode for minimal bandwidth.</p></div>';
}

function ensureLiveStage() {
    const preview = $('livePreview');
    let stage = $('liveStage');
    if (!stage) {
        preview.innerHTML =
            '<div class="live-stage ' + (liveFitMode === 'actual' ? 'actual' : '') + '" id="liveStage">' +
                '<canvas class="live-frame" id="liveCanvas" tabindex="0" aria-label="Remote desktop canvas"></canvas>' +
                '<div class="live-hud" id="liveHud"><span>Waiting for frames...</span></div>' +
            '</div>';
        stage = $('liveStage');
        wireLiveCanvas();
    }
    return stage;
}

function updateLivePreview(imageData, width, height, frameIndex, monitor) {
    if (livePaused || !isStreaming) return;
    ensureLiveStage();
    const now = performance.now();
    const instantFps = lastFrameAt ? Math.round(1000 / Math.max(1, now - lastFrameAt)) : 0;
    lastFrameAt = now;
    const canvas = $('liveCanvas');
    const context = canvas.getContext('2d', { alpha: false });
    const image = new Image();
    image.onload = () => {
        canvas.width = width || image.width;
        canvas.height = height || image.height;
        canvas.style.width = liveFitMode === 'actual' ? canvas.width + 'px' : '100%';
        canvas.style.height = liveFitMode === 'actual' ? canvas.height + 'px' : 'auto';
        context.drawImage(image, 0, 0, canvas.width, canvas.height);
    };
    image.src = 'data:image/jpeg;base64,' + imageData;
    liveFrameMeta = {
        width: width || liveFrameMeta.width,
        height: height || liveFrameMeta.height,
        monitor: monitor || liveFrameMeta.monitor,
    };
    updateLiveStats(imageData.length, instantFps);

    $('liveResolutionStat').textContent = (width || '?') + 'x' + (height || '?');
    $('liveHud').innerHTML =
        '<span>' + (liveControlUnlocked ? 'CONTROL' : 'VIEW') + '</span><span>' + escHtml(width || '?') + 'x' + escHtml(height || '?') + '</span><span>' + liveStats.fps + ' fps</span>';
}

function toggleLiveFit() {
    liveFitMode = liveFitMode === 'fit' ? 'actual' : 'fit';
    ensureLiveStage().classList.toggle('actual', liveFitMode === 'actual');
    $('fitStreamButton').textContent = liveFitMode === 'fit' ? 'Fit' : 'Actual';
}

function openLiveFullscreen() {
    const target = $('livePreview');
    if (!target.requestFullscreen) {
        toast('Fullscreen is not supported here', 'error');
        return;
    }
    target.requestFullscreen().catch(() => toast('Could not open fullscreen', 'error'));
}

function adjustLiveStream(field, value) {
    if (!liveStreamId || !isStreaming) return;
    sendCommand('adjust_stream', { streamId: liveStreamId, [field]: value });
}

function wireLiveCanvas() {
    const canvas = $('liveCanvas');
    canvas.style.touchAction = 'none';
    canvas.addEventListener('pointerdown', event => {
        if (!liveControlUnlocked || livePaused || !isStreaming) return;
        event.preventDefault();
        canvas.focus();
        livePointerButton = pointerButtonName(event);
        const point = mapCanvasPoint(event);
        if (!point) return;
        liveDragging = true;
        liveMouseDownSent = false;
        liveStartPoint = point;
        canvas.setPointerCapture?.(event.pointerId);
        if (event.pointerType === 'touch') {
            liveLongPressTimer = setTimeout(() => {
                sendRemoteInput('click', { ...point, button: 'right' });
                liveDragging = false;
            }, 620);
        }
    });
    canvas.addEventListener('pointermove', throttle(event => {
        if (!liveControlUnlocked || !liveDragging || livePaused || !isStreaming) return;
        const point = mapCanvasPoint(event);
        if (!point) return;
        const distance = liveStartPoint ? Math.hypot(point.x - liveStartPoint.x, point.y - liveStartPoint.y) : 0;
        if (!liveMouseDownSent && distance > 6) {
            sendRemoteInput('mouse_down', { ...liveStartPoint, button: livePointerButton });
            liveMouseDownSent = true;
        }
        if (liveMouseDownSent) sendRemoteInput('mouse_move', point);
    }, 30));
    canvas.addEventListener('pointerup', event => {
        if (!liveControlUnlocked || !isStreaming) return;
        clearTimeout(liveLongPressTimer);
        const point = mapCanvasPoint(event);
        if (point && liveDragging && liveMouseDownSent) sendRemoteInput('mouse_up', { ...point, button: livePointerButton });
        if (point && liveDragging && !liveMouseDownSent && !livePaused) sendRemoteInput('click', { ...point, button: livePointerButton });
        liveDragging = false;
        liveMouseDownSent = false;
    });
    canvas.addEventListener('click', event => {
        if (liveControlUnlocked) event.preventDefault();
    });
    canvas.addEventListener('dblclick', event => {
        if (!liveControlUnlocked || livePaused || !isStreaming) return;
        const point = mapCanvasPoint(event);
        if (point) sendRemoteInput('double_click', { ...point, button: 'left' });
    });
    canvas.addEventListener('contextmenu', event => {
        if (!liveControlUnlocked || livePaused || !isStreaming) return;
        event.preventDefault();
        const point = mapCanvasPoint(event);
        if (point) sendRemoteInput('click', { ...point, button: 'right' });
    });
    canvas.addEventListener('wheel', event => {
        if (!liveControlUnlocked || livePaused || !isStreaming) return;
        event.preventDefault();
        sendRemoteInput('scroll', { delta: Math.sign(event.deltaY) * -20 });
    }, { passive: false });
}

function mapCanvasPoint(event) {
    const canvas = $('liveCanvas');
    if (!canvas || !canvas.width || !canvas.height) return null;
    const rect = canvas.getBoundingClientRect();
    const x = Math.max(0, Math.min(canvas.width, (event.clientX - rect.left) * (canvas.width / rect.width)));
    const y = Math.max(0, Math.min(canvas.height, (event.clientY - rect.top) * (canvas.height / rect.height)));
    const monitor = liveFrameMeta.monitor || {};
    const monitorWidth = monitor.width || canvas.width;
    const monitorHeight = monitor.height || canvas.height;
    return {
        x: Math.round((monitor.x || 0) + x * (monitorWidth / canvas.width)),
        y: Math.round((monitor.y || 0) + y * (monitorHeight / canvas.height)),
    };
}

function pointerButtonName(event) {
    if (event.button === 2) return 'right';
    if (event.button === 1) return 'middle';
    return 'left';
}

function sendRemoteInput(action, params = {}) {
    if (!liveControlUnlocked || !isStreaming) return;
    sendCommand('remote_input', { action, ...params });
}

function handleLiveKey(event) {
    if (!liveControlUnlocked || !document.getElementById('tab-live').classList.contains('active') || !isStreaming) return;
    if (event.target && ['INPUT', 'TEXTAREA', 'SELECT'].includes(event.target.tagName)) return;
    if (event.key === 'Escape') {
        setControlLock(false);
        return;
    }
    if (event.ctrlKey || event.altKey || event.metaKey || event.shiftKey) {
        event.preventDefault();
        const keys = [];
        if (event.ctrlKey) keys.push('ctrl');
        if (event.altKey) keys.push('alt');
        if (event.metaKey) keys.push('win');
        if (event.shiftKey) keys.push('shift');
        const keyName = event.key.toLowerCase();
        if (!['control','shift','alt','meta'].includes(keyName)) keys.push(keyName);
        sendRemoteInput('hotkey', { keys });
        return;
    }
    if (event.key.length === 1) {
        event.preventDefault();
        sendRemoteInput('type', { text: event.key });
    } else {
        event.preventDefault();
        sendRemoteInput('key', { key: event.key });
    }
}

function setControlLock(enabled) {
    liveControlUnlocked = enabled;
    $('controlLockButton').textContent = enabled ? 'Lock input' : 'Unlock';
    $('controlLockButton').classList.toggle('control-active', enabled);
    $('livePreview').classList.toggle('control-active', enabled);
    toast(enabled ? 'Remote control unlocked' : 'Remote control locked', enabled ? 'success' : 'info');
}

function toggleControlLock() {
    setControlLock(!liveControlUnlocked);
}

function toggleStreamPause() {
    livePaused = !livePaused;
    $('pauseStreamButton').textContent = livePaused ? 'Resume' : 'Pause';

    if (livePaused) {
        $('liveStatus').textContent = 'Live stream PAUSED. Click Resume to continue.';
        addPausedOverlay();
    } else {
        $('liveStatus').textContent = 'Live stream active.';
        removePausedOverlay();
    }
    toast(livePaused ? 'Stream paused' : 'Stream resumed', 'info');
}

function addPausedOverlay() {
    const stage = $('liveStage');
    if (stage && !$('pausedOverlay')) {
        const overlay = document.createElement('div');
        overlay.id = 'pausedOverlay';
        overlay.className = 'paused-overlay';
        overlay.innerHTML = '<div class="paused-badge">PAUSED</div>';
        stage.appendChild(overlay);
    }
}

function removePausedOverlay() {
    const overlay = $('pausedOverlay');
    if (overlay) overlay.remove();
}

function resetLiveStats() {
    liveStats = { frames: 0, bytes: 0, fps: 0, bitrate: 0, lastStatsAt: performance.now(), lastAdaptiveAt: 0 };
    lastFrameAt = 0;
    $('liveFpsStat').textContent = '-- fps';
    $('liveBitrateStat').textContent = '-- kbps';
}

function updateLiveStats(base64Length, instantFps) {
    const now = performance.now();
    liveStats.frames += 1;
    liveStats.bytes += Math.round((base64Length || 0) * 0.75);
    if (now - liveStats.lastStatsAt >= 1000) {
        const seconds = (now - liveStats.lastStatsAt) / 1000;
        liveStats.fps = Math.round(liveStats.frames / seconds);
        liveStats.bitrate = Math.round((liveStats.bytes * 8) / seconds / 1000);
        liveStats.frames = 0;
        liveStats.bytes = 0;
        liveStats.lastStatsAt = now;
        $('liveFpsStat').textContent = liveStats.fps + ' fps';
        $('liveBitrateStat').textContent = liveStats.bitrate + ' kbps';
        updateBwMeter(liveStats.bitrate);
        adaptiveSpyThrottle(liveStats.bitrate);
    } else if (instantFps) {
        liveStats.fps = instantFps;
    }
}

function startLivePing() {
    stopLivePing();
    livePingTimer = setInterval(() => {
        if (isStreaming && selectedPC) sendCommand('ping');
    }, 5000);
}

function stopLivePing() {
    if (livePingTimer) clearInterval(livePingTimer);
    livePingTimer = null;
}

function playAudioChunk(payload) {
    if (!payload.audioData || !audioEnabled) return;
    try {
        audioContext = audioContext || new (window.AudioContext || window.webkitAudioContext)({ sampleRate: payload.sampleRate || 44100 });
        const bytes = base64ToUint8Array(payload.audioData);
        const samples = new Int16Array(bytes.buffer);
        const audioBuffer = audioContext.createBuffer(payload.channels || 1, samples.length, payload.sampleRate || 44100);
        const channel = audioBuffer.getChannelData(0);
        for (let index = 0; index < samples.length; index++) channel[index] = samples[index] / 32768;
        const source = audioContext.createBufferSource();
        source.buffer = audioBuffer;
        source.connect(audioContext.destination);
        source.start();
    } catch (error) {
        console.warn('Audio playback failed', error);
    }
}

function renderMonitorOptions(monitors, selected = 0) {
    if (!monitors.length) return;
    $('streamMonitor').innerHTML = monitors.map((monitor, index) =>
        '<option value="' + escAttr(monitor.index ?? index) + '"' + (Number(monitor.index ?? index) === Number(selected) ? ' selected' : '') + '>' +
        escHtml((monitor.name || 'Monitor ' + (index + 1)) + ' - ' + monitor.width + 'x' + monitor.height) +
        '</option>'
    ).join('');
}

function showMobileKeyboard() {
    showModal('Mobile keyboard',
        '<textarea id="remoteKeyboardInput" placeholder="Type text for the remote PC"></textarea>',
        [
            { label: 'Cancel', action: closeModal },
            { label: 'Send', primary: true, action: () => {
                const text = $('remoteKeyboardInput').value;
                if (text) sendRemoteInput('type', { text });
                closeModal();
            }}
        ]
    );
}

function throttle(callback, wait) {
    let last = 0;
    return function throttled(...args) {
        const now = Date.now();
        if (now - last >= wait) {
            last = now;
            callback.apply(this, args);
        }
    };
}

function runCommand(commandOverride = '') {
    const input = $('terminalInput');
    const command = (commandOverride || input.value).trim();
    if (!command) return;
    terminalHistory.push(command);
    terminalHistoryIndex = terminalHistory.length;
    appendTerminal('> ' + command, 'cmd-line');
    sendCommand('execute_command', { command });
    input.value = '';
}

function renderTerminalOutput(data) {
    const text = data.stderr || data.error || data.stdout || '';
    if (text) appendTerminal(text, data.stderr || data.error ? 'cmd-error' : 'cmd-output');
}

function appendTerminal(text, className) {
    const output = $('terminalOutput');
    output.innerHTML += '<div class="' + className + '">' + escHtml(text) + '</div>';
    output.scrollTop = output.scrollHeight;
}

function renderSystemInfo() {
    const client = clients[selectedPC];
    if (!client) return;
    const info = client.systemInfo || {};
    const rows = {
        'Device name': client.name,
        'Hostname': client.hostname,
        'IP address': client.ip,
        'Platform': info.platform || 'N/A',
        'Processor': info.processor || 'N/A',
        'Username': info.username || 'N/A',
        'Python': info.python_version || 'N/A',
        'Status': client.online ? 'Online' : 'Offline'
    };

    $('infoGrid').innerHTML =
        '<div class="info-card"><h3>System information</h3>' + infoRows(rows) + '</div>' +
        '<div class="info-card"><h3>Quick actions</h3>' +
        '<div class="modal-buttons">' +
        '<button class="tool-button" type="button" data-info-action="ping">Ping</button>' +
        '<button class="tool-button" type="button" data-info-action="screenshot">Screenshot</button>' +
        '<button class="tool-button" type="button" data-info-command="ipconfig">IP config</button>' +
        '<button class="tool-button" type="button" data-info-command="systeminfo">System info</button>' +
        '</div></div>';

    $('infoGrid').querySelectorAll('[data-info-command]').forEach(button => {
        button.addEventListener('click', () => {
            switchTab('terminal');
            runCommand(button.dataset.infoCommand);
        });
    });
    $('infoGrid').querySelector('[data-info-action="ping"]').addEventListener('click', () => sendCommand('ping'));
    $('infoGrid').querySelector('[data-info-action="screenshot"]').addEventListener('click', () => {
        switchTab('screenshot');
        takeScreenshot();
    });
}

function infoRows(rows) {
    return Object.entries(rows).map(([label, value]) =>
        '<div class="info-row"><span class="label">' + escHtml(label) + '</span><span class="value">' + escHtml(value || 'N/A') + '</span></div>'
    ).join('');
}

function showModal(title, bodyHtml, buttons = []) {
    const overlay = $('modalOverlay');
    const content = $('modalContent');
    content.innerHTML = '<h2>' + escHtml(title) + '</h2>' + bodyHtml +
        '<div class="modal-buttons">' + buttons.map((button, index) =>
            '<button class="' + (button.primary ? 'primary-button' : 'tool-button') + '" type="button" data-modal-button="' + index + '">' + escHtml(button.label) + '</button>'
        ).join('') + '</div>';
    overlay.classList.add('active');
    buttons.forEach((button, index) => {
        content.querySelector('[data-modal-button="' + index + '"]').addEventListener('click', button.action);
    });
    setTimeout(() => {
        const input = content.querySelector('input, textarea');
        if (input) {
            input.focus();
            input.addEventListener('keydown', event => {
                if (event.key === 'Enter' && input.tagName !== 'TEXTAREA') {
                    const primary = buttons.find(button => button.primary);
                    if (primary) primary.action();
                }
            });
        }
    }, 30);
}

function closeModal() {
    $('modalOverlay').classList.remove('active');
}

function setTransferStatus(text, level = 'info') {
    const element = $('transferStatus');
    element.hidden = false;
    element.className = 'transfer-status ' + level;
    element.textContent = text;
}

function clearTransferStatus() {
    const element = $('transferStatus');
    element.hidden = true;
    element.textContent = '';
    element.className = 'transfer-status';
}

function triggerUpload() {
    $('uploadInput').click();
}

function wireDropTarget(element) {
    if (!element) return;
    element.addEventListener('dragover', event => {
        event.preventDefault();
        element.classList.add('dragover');
    });
    element.addEventListener('dragleave', () => element.classList.remove('dragover'));
    element.addEventListener('drop', event => {
        event.preventDefault();
        element.classList.remove('dragover');
        if (event.dataTransfer.files.length) handleUpload(event.dataTransfer.files);
    });
}

function base64ToUint8Array(base64) {
    const raw = atob(base64 || '');
    const bytes = new Uint8Array(raw.length);
    for (let index = 0; index < raw.length; index++) bytes[index] = raw.charCodeAt(index);
    return bytes;
}

function arrayBufferToBase64(buffer) {
    const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
    let binary = '';
    const chunk = 0x8000;
    for (let index = 0; index < bytes.length; index += chunk) {
        binary += String.fromCharCode.apply(null, bytes.subarray(index, index + chunk));
    }
    return btoa(binary);
}

function readFileAsArrayBuffer(file) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = () => reject(reader.error);
        reader.readAsArrayBuffer(file);
    });
}

function getExtension(name) {
    const parts = String(name || '').split('.');
    return parts.length > 1 ? parts.pop().toLowerCase() : '';
}

function parseSizeValue(value) {
    const text = String(value || '').toLowerCase();
    const number = parseFloat(text) || 0;
    if (text.includes('gb')) return number * 1024 * 1024 * 1024;
    if (text.includes('mb')) return number * 1024 * 1024;
    if (text.includes('kb')) return number * 1024;
    return number;
}

function fileNameFromPath(pathValue) {
    return String(pathValue || 'download').replace(/\\/g, '/').split('/').filter(Boolean).pop() || 'download';
}

function joinPath(base, name) {
    if (!base || base === '/') return '/' + name;
    return base.replace(/[\\/]+$/, '') + '/' + name;
}

function escHtml(value) {
    const element = document.createElement('div');
    element.textContent = String(value ?? '');
    return element.innerHTML;
}

function escAttr(value) {
    return String(value ?? '').replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/'/g, '&#39;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function wireUi() {
    $('loginHost').textContent = location.host || 'localhost:3000';
    $('loginButton').addEventListener('click', doLogin);
    $('loginPassword').addEventListener('keydown', event => {
        if (event.key === 'Enter') doLogin();
    });
    $('logoutButton').addEventListener('click', doLogout);
    $('topbarMenuToggle').addEventListener('click', () => {
        $('topbarActions').classList.toggle('open');
    });
    document.addEventListener('click', event => {
        if (!event.target.closest('.topbar-actions') && !event.target.closest('#topbarMenuToggle')) {
            $('topbarActions').classList.remove('open');
        }
    });

    const appShell = $('app');
    function openSidebar() {
        appShell.classList.add('sidebar-open');
        appShell.classList.remove('sidebar-closed');
    }
    function closeSidebar() {
        appShell.classList.remove('sidebar-open');
        appShell.classList.add('sidebar-closed');
    }
    function toggleSidebar() {
        if (appShell.classList.contains('sidebar-open') || appShell.classList.contains('sidebar-closed')) {
            appShell.classList.toggle('sidebar-open');
            appShell.classList.toggle('sidebar-closed');
        } else {
            // Default state: sidebar visible on desktop, hidden on mobile
            if (window.innerWidth <= 760) {
                openSidebar();
            } else {
                closeSidebar();
            }
        }
    }
    if ($('sidebarToggle')) {
        $('sidebarToggle').addEventListener('click', () => {
            if (window.innerWidth <= 760) {
                openSidebar();
            } else {
                toggleSidebar();
            }
        });
    }
    if ($('sidebarCloseToggle')) {
        $('sidebarCloseToggle').addEventListener('click', () => {
            if (window.innerWidth <= 760) {
                closeSidebar();
            } else {
                closeSidebar();
            }
        });
    }
    // Close sidebar when clicking overlay on mobile
    document.addEventListener('click', event => {
        if (window.innerWidth <= 760 && appShell.classList.contains('sidebar-open')) {
            if (!event.target.closest('.sidebar') && !event.target.closest('#sidebarToggle')) {
                closeSidebar();
            }
        }
    });
    // Close sidebar on escape key
    document.addEventListener('keydown', event => {
        if (event.key === 'Escape') {
            closeSidebar();
        }
    });
    $('refreshClientsButton').addEventListener('click', fetchClients);
    $('pcSearch').addEventListener('input', renderPCList);
    $('quickPingButton').addEventListener('click', () => sendCommand('ping'));
    $('quickScreenshotButton').addEventListener('click', () => {
        switchTab('screenshot');
        takeScreenshot();
    });
    document.querySelectorAll('.tab').forEach(button => button.addEventListener('click', () => switchTab(button.dataset.tab)));
    $('drivesButton').addEventListener('click', loadDrives);
    $('upButton').addEventListener('click', goUp);
    $('refreshFilesButton').addEventListener('click', refreshFiles);
    $('newFolderButton').addEventListener('click', showNewFolderModal);
    $('uploadButton').addEventListener('click', triggerUpload);
    $('uploadInput').addEventListener('change', event => handleUpload(event.target.files));
    $('fileSearch').addEventListener('input', () => renderFileItems(getVisibleItems()));
    $('fileSort').addEventListener('change', () => renderFileItems(getVisibleItems()));
    $('selectAllButton').addEventListener('click', () => {
        selectedFiles.clear();
        document.querySelectorAll('.file-item').forEach(item => {
            selectedFiles.add(item.dataset.path);
            item.classList.add('selected');
        });
        updateBulkActions();
    });
    $('deselectAllButton').addEventListener('click', () => {
        selectedFiles.clear();
        document.querySelectorAll('.file-item').forEach(item => item.classList.remove('selected'));
        updateBulkActions();
    });
    $('bulkDeleteButton').addEventListener('click', () => {
        if (selectedFiles.size === 0) {
            toast('No files selected', 'error');
            return;
        }
        if (confirm('Delete ' + selectedFiles.size + ' file(s)? This cannot be undone.')) {
            selectedFiles.forEach(path => deleteFile(path));
            selectedFiles.clear();
            updateBulkActions();
            setTimeout(refreshFiles, 500);
        }
    });

    $('manualPathInput').addEventListener('keydown', event => {
        if (event.key === 'Enter') handleManualPathInput();
    });
    $('goToPathButton').addEventListener('click', handleManualPathInput);

    document.querySelectorAll('.quick-path').forEach(btn => {
        btn.addEventListener('click', () => handleQuickPath(btn.dataset.path));
    });

    document.querySelectorAll('.quality-preset[data-quality]').forEach(btn => {
        btn.addEventListener('click', () => {
            screenshotQuality = Number(btn.dataset.quality);
            document.querySelectorAll('.quality-preset[data-quality]').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
        });
    });

    $('captureScreenshotButton').addEventListener('click', takeScreenshot);
    $('clearScreenshotsButton').addEventListener('click', clearScreenshots);

    $('startStreamButton').addEventListener('click', startLiveStream);
    $('stopStreamButton').addEventListener('click', stopLiveStream);
    document.body.addEventListener('dragover', event => event.preventDefault());
    document.body.addEventListener('drop', event => {
        event.preventDefault();
        if (event.dataTransfer?.files?.length) handleUpload(event.dataTransfer.files);
    });
    if ('ontouchstart' in window || navigator.maxTouchPoints > 0) {
        $('mobileKeyboardButton').style.display = 'block';
    }
    $('fitStreamButton').addEventListener('click', toggleLiveFit);
    $('fullStreamButton').addEventListener('click', openLiveFullscreen);
    $('controlLockButton').addEventListener('click', toggleControlLock);
    $('pauseStreamButton').addEventListener('click', toggleStreamPause);

    document.querySelectorAll('.quality-preset.live-preset').forEach(btn => {
        btn.addEventListener('click', () => setStreamQualityPreset(btn.dataset.preset));
    });

    $('audioEnabledCheckbox').addEventListener('change', event => {
        audioEnabled = event.target.checked;
        if (!audioEnabled && audioContext) {
            audioContext.close();
            audioContext = null;
        }
        toast(audioEnabled ? 'Audio enabled' : 'Audio disabled', 'info');
    });

    $('advancedSettingsToggle').addEventListener('click', () => {
        const panel = $('liveAdvancedSettings');
        const isHidden = panel.hidden;
        panel.hidden = !isHidden;
        $('advancedSettingsToggle').textContent = isHidden ? 'Hide Settings' : 'Advanced Settings';
    });

    $('streamQuality').addEventListener('input', () => {
        if (isStreaming) adjustLiveStream('quality', Number($('streamQuality').value) || 35);
    });
    $('streamFps').addEventListener('change', () => {
        if (isStreaming) adjustLiveStream('fps', Number($('streamFps').value) || 8);
    });
    $('streamResolution').addEventListener('change', () => {
        if (isStreaming) adjustLiveStream('resolution', Number($('streamResolution').value) || 0.5);
    });
    $('streamMonitor').addEventListener('change', () => {
        if (isStreaming) adjustLiveStream('monitor', Number($('streamMonitor').value) || 0);
    });

    $('mobileKeyboardButton').addEventListener('click', showMobileKeyboard);
    $('runCommandButton').addEventListener('click', () => runCommand());
    $('clearTerminalButton').addEventListener('click', () => {
        $('terminalOutput').innerHTML = '<div class="cmd-muted">Terminal cleared.</div>';
    });
    $('terminalInput').addEventListener('keydown', event => {
        if (event.key === 'Enter') runCommand();
        if (event.key === 'ArrowUp') {
            event.preventDefault();
            terminalHistoryIndex = Math.max(0, terminalHistoryIndex - 1);
            $('terminalInput').value = terminalHistory[terminalHistoryIndex] || '';
        }
        if (event.key === 'ArrowDown') {
            event.preventDefault();
            terminalHistoryIndex = Math.min(terminalHistory.length, terminalHistoryIndex + 1);
            $('terminalInput').value = terminalHistory[terminalHistoryIndex] || '';
        }
    });
    document.querySelectorAll('.preset-command').forEach(button => {
        button.addEventListener('click', () => runCommand(button.dataset.command));
    });
    $('clearActivityButton').addEventListener('click', () => {
        $('activityLog').innerHTML = '';
        $('activityMetric').textContent = 'Ready';
    });
    $('modalOverlay').addEventListener('click', event => {
        if (event.target === $('modalOverlay')) closeModal();
    });
    document.addEventListener('keydown', event => {
        handleLiveKey(event);
        if (event.key === 'Escape') closeModal();
        if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'r') {
            event.preventDefault();
            selectedPC ? refreshFiles() : fetchClients();
        }
    });

    $('terminalOutput').innerHTML = '<div class="cmd-muted">Terminal ready. Type a command and press Enter.</div>';
    renderScreenshotEmpty();
    renderLiveEmpty();

    // Mode wiring
    $('modeSpyBtn').addEventListener('click', () => setAppMode('spy'));
    $('modeNormalBtn').addEventListener('click', () => setAppMode('normal'));
    $('bwLimitInput').value = spyBandwidthKbps;
    $('bwLimitInput').addEventListener('change', () => setSpyBandwidth($('bwLimitInput').value));
    applyModeToUi();
}

document.addEventListener('DOMContentLoaded', () => {
    wireUi();
    if (token) {
        fetch('/api/clients', { headers: { Authorization: 'Bearer ' + token } })
            .then(response => response.ok ? enterApp() : doLogout())
            .catch(() => {});
    }
});

window.doLogin = doLogin;
window.doLogout = doLogout;
window.switchTab = switchTab;
window.selectPC = selectPC;
window.loadFiles = loadFiles;
window.goUp = goUp;
window.refreshFiles = refreshFiles;
window.downloadFile = downloadFile;
window.deleteFile = deleteFile;
window.showRenameModal = showRenameModal;
window.showNewFolderModal = showNewFolderModal;
window.triggerUpload = triggerUpload;
window.handleUpload = handleUpload;
window.takeScreenshot = takeScreenshot;
window.downloadScreenshot = downloadScreenshot;
window.sendCommand = sendCommand;
window.runCommand = runCommand;
window.closeModal = closeModal;
