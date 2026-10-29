let currentTheme = document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'light';
const THEME_COLORS = {
    light: { nodeBg: '#ffffff', nodeBgPinned: '#eeeeee', nodeBgHighlight: '#e8e8e8', nodeBgPinnedHighlight: '#dedede', nodeBgHover: '#f4f4f4', nodeBgPinnedHover: '#e2e2e2', defaultNodeBorder: '#222222', squareBg: '#e7e6eb', squareBorder: '#393742', squareHighlight: '#d8d7df', squareHover: '#cfced8', fontColor: '#222222', edgeColor: '#555555', edgeHighlight: '#111111', edgeFontColor: '#444444', edgeFontBg: '#fafafa', edgeFontStroke: '#fafafa', blockEdgeColor: '#62606e', canvasBg: '#fafafa', shadowColor: 'rgba(0,0,0,0.24)' },
    dark: { nodeBg: '#302e39', nodeBgPinned: '#41404e', nodeBgHighlight: '#4c4a5c', nodeBgPinnedHighlight: '#59576b', nodeBgHover: '#3b3947', nodeBgPinnedHover: '#4b495b', defaultNodeBorder: '#d3cede', squareBg: '#484553', squareBorder: '#d9d4e5', squareHighlight: '#5a566b', squareHover: '#625d74', fontColor: '#f4f1fb', edgeColor: '#b8b3c8', edgeHighlight: '#ded9e8', edgeFontColor: '#aaa4bb', edgeFontBg: '#2c2a35', edgeFontStroke: '#2c2a35', blockEdgeColor: '#aaa4bc', canvasBg: '#24222d', shadowColor: 'rgba(0,0,0,0.62)' }
};

window.toggleTheme = function () {
    currentTheme = currentTheme === 'dark' ? 'light' : 'dark';
    applyTheme(currentTheme);
    try { localStorage.setItem('graph-editor-theme', currentTheme); } catch (e) { }
};

function applyTheme(theme) {
    currentTheme = theme;
    document.documentElement.setAttribute('data-theme', theme);
    const icon = document.getElementById('themeIcon');
    if (icon) icon.textContent = '◐';
    if (typeof network !== 'undefined' && network) {
        const tc = THEME_COLORS[theme];
        network.setOptions({
            nodes: { font: { color: tc.fontColor } },
            edges: { color: { color: tc.edgeColor, highlight: tc.edgeHighlight }, font: { color: tc.edgeFontColor, background: tc.edgeFontBg, strokeColor: tc.edgeFontStroke } }
        });
        if (nodesDataset) {
            nodesDataset.update(nodesDataset.get().map(node => getStyleObject(node, {})));
        }
        if (edgesDataset && isBCTreeMode) {
            edgesDataset.update(edgesDataset.get().map(edge => ({ id: edge.id, color: { color: tc.blockEdgeColor, highlight: tc.edgeHighlight, hover: tc.edgeHighlight } })));
        }
    }
}

const OUTPUT_HISTORY_LIMIT = 200;
let outputUndoStack = [];
let outputRedoStack = [];
let outputHistoryCurrent = null;
let outputHistoryPendingBefore = null;
let outputHistoryGroup = null;
let outputHistoryComposing = false;

function getOutputSnapshot() {
    const output = document.getElementById('output');
    if (!output) return { value: '', selectionStart: 0, selectionEnd: 0, scrollTop: 0 };
    return {
        value: output.value,
        selectionStart: Number.isInteger(output.selectionStart) ? output.selectionStart : output.value.length,
        selectionEnd: Number.isInteger(output.selectionEnd) ? output.selectionEnd : output.value.length,
        scrollTop: output.scrollTop || 0
    };
}

function resetOutputHistoryBaseline() {
    outputUndoStack = [];
    outputRedoStack = [];
    outputHistoryPendingBefore = null;
    outputHistoryGroup = null;
    outputHistoryCurrent = getOutputSnapshot();
}

function setOutputProgrammatically(value) {
    const output = document.getElementById('output');
    if (!output) return;
    output.value = String(value ?? '');
    // Changes originating from graph controls/generation are not textarea edits.
    // Re-baseline here so Ctrl+Z never undoes a graph-side operation.
    resetOutputHistoryBaseline();
}

function outputInputFamily(inputType) {
    if (inputType === 'insertText' || inputType === 'insertCompositionText') return 'typing';
    if (inputType === 'deleteContentBackward') return 'backspace';
    if (inputType === 'deleteContentForward') return 'forward-delete';
    return null;
}

function restoreOutputSnapshot(snapshot) {
    const output = document.getElementById('output');
    if (!output || !snapshot) return;
    output.value = snapshot.value;
    if (typeof output.setSelectionRange === 'function') {
        const start = Math.min(snapshot.selectionStart ?? snapshot.value.length, output.value.length);
        const end = Math.min(snapshot.selectionEnd ?? start, output.value.length);
        try { output.setSelectionRange(start, end); } catch (e) { }
    }
    output.scrollTop = snapshot.scrollTop || 0;
    outputHistoryPendingBefore = null;
    outputHistoryGroup = null;
    outputHistoryCurrent = getOutputSnapshot();
    // Programmatic value assignment does not fire input, so explicitly rebuild the graph.
    window.renderGraphFromText();
}

function undoOutputEdit() {
    if (!outputUndoStack.length) return;
    const current = getOutputSnapshot();
    const previous = outputUndoStack.pop();
    outputRedoStack.push(current);
    if (outputRedoStack.length > OUTPUT_HISTORY_LIMIT) outputRedoStack.shift();
    restoreOutputSnapshot(previous);
}

function redoOutputEdit() {
    if (!outputRedoStack.length) return;
    const current = getOutputSnapshot();
    const next = outputRedoStack.pop();
    outputUndoStack.push(current);
    if (outputUndoStack.length > OUTPUT_HISTORY_LIMIT) outputUndoStack.shift();
    restoreOutputSnapshot(next);
}

function initOutputHistory() {
    const output = document.getElementById('output');
    if (!output) return;
    resetOutputHistoryBaseline();

    output.addEventListener('beforeinput', () => {
        outputHistoryPendingBefore = getOutputSnapshot();
    });

    output.addEventListener('compositionstart', () => {
        outputHistoryComposing = true;
        outputHistoryGroup = null;
        outputHistoryPendingBefore = getOutputSnapshot();
    });
    output.addEventListener('compositionend', () => {
        outputHistoryComposing = false;
        outputHistoryGroup = null;
    });

    output.addEventListener('input', event => {
        const before = outputHistoryPendingBefore || outputHistoryCurrent || getOutputSnapshot();
        const after = getOutputSnapshot();
        outputHistoryPendingBefore = null;
        if (before.value === after.value) {
            outputHistoryCurrent = after;
            return;
        }

        const now = Date.now();
        const family = outputInputFamily(event.inputType || '');
        const canCoalesce = !!family && !outputHistoryComposing;
        const sameRecentGroup = canCoalesce && outputHistoryGroup &&
            outputHistoryGroup.family === family && now - outputHistoryGroup.time <= 750;

        if (!sameRecentGroup) {
            outputUndoStack.push(before);
            if (outputUndoStack.length > OUTPUT_HISTORY_LIMIT) outputUndoStack.shift();
        }
        outputRedoStack = [];
        outputHistoryGroup = canCoalesce ? { family, time: now } : null;
        outputHistoryCurrent = after;
    });

    output.addEventListener('keydown', event => {
        if (!(event.ctrlKey || event.metaKey) || event.altKey) return;
        const key = String(event.key || '').toLowerCase();
        const isUndo = key === 'z' && !event.shiftKey;
        const isRedo = key === 'y' || (key === 'z' && event.shiftKey);
        if (!isUndo && !isRedo) return;
        // Keep browser-native textarea history out of this app-specific history.
        event.preventDefault();
        event.stopPropagation();
        if (isUndo) undoOutputEdit();
        else redoOutputEdit();
    });
}

function rand(l, r) { return Math.floor(Math.random() * (r - l + 1)) + l; }
function insertSorted(arr, val) { let low = 0, high = arr.length - 1; while (low <= high) { let mid = Math.floor((low + high) / 2); if (arr[mid] < val) low = mid + 1; else high = mid - 1; } arr.splice(low, 0, val); }

function getEdges_Tree(n) { if (n <= 1) return []; if (n === 2) return [[1, 2]]; let edges = [], degree = new Array(n + 1).fill(1), sequence = []; for (let i = 0; i < n - 2; i++) { let node = rand(1, n); sequence.push(node); degree[node]++; } let leaves = []; for (let i = 1; i <= n; i++) if (degree[i] === 1) leaves.push(i); leaves.sort((a, b) => a - b); for (let i = 0; i < n - 2; i++) { let u = leaves.shift(), v = sequence[i]; edges.push([u, v]); if (--degree[v] === 1) insertSorted(leaves, v); } edges.push([leaves[0], leaves[1]]); return edges; }
function getEdges_Chain(n) { let edges = []; for (let i = 1; i < n; i++) edges.push([i, i + 1]); return edges; }
function getEdges_Daisy(n) { let edges = []; for (let i = 2; i <= n; i++) edges.push([1, i]); return edges; }

function getEdges_Binary(n) { 
    if (n <= 1) return [];
    let edges = [];
    let childCount = new Array(n + 1).fill(0);
    let available = [1];
    for (let i = 2; i <= n; i++) {
        let randIdx = rand(0, available.length - 1);
        let u = available[randIdx];
        edges.push([u, i]);
        childCount[u]++;
        if (childCount[u] === 2) available.splice(randIdx, 1);
        available.push(i);
    }
    return edges; 
}

function getEdges_Graph(n, m, isDirected) { let set = new Set(), edges = []; let maxEdges = isDirected ? n * (n - 1) : n * (n - 1) / 2; m = Math.min(m, maxEdges); while (set.size < m) { let u = rand(1, n), v = rand(1, n); if (u === v) continue; if (!isDirected && u > v) [u, v] = [v, u]; let key = `${u}-${v}`; if (!set.has(key)) { set.add(key); edges.push([u, v]); } } return edges; }

function getEdges_Cactus(n, m) {
    if (n <= 1) return [];
    const minEdges = n - 1;
    const maxEdges = n - 1 + Math.floor((n - 1) / 2);
    const targetEdges = Math.max(minEdges, Math.min(maxEdges, Math.floor(Number(m) || minEdges)));
    let cyclesLeft = targetEdges - minEdges;
    const unused = Array.from({ length: n - 1 }, (_, i) => i + 2);
    for (let i = unused.length - 1; i > 0; i--) {
        const j = rand(0, i);
        [unused[i], unused[j]] = [unused[j], unused[i]];
    }
    const existing = [1];
    const edges = [];

    while (cyclesLeft > 0) {
        const cyclesAfter = cyclesLeft - 1;
        const maxNewNodes = Math.min(5, unused.length - 2 * cyclesAfter);
        const newNodeCount = maxNewNodes <= 2 ? 2 : rand(2, maxNewNodes);
        const anchor = existing[rand(0, existing.length - 1)];
        const cycleNodes = [anchor];
        for (let i = 0; i < newNodeCount; i++) {
            const node = unused.pop();
            cycleNodes.push(node);
            existing.push(node);
        }
        for (let i = 0; i + 1 < cycleNodes.length; i++) edges.push([cycleNodes[i], cycleNodes[i + 1]]);
        edges.push([cycleNodes[cycleNodes.length - 1], anchor]);
        cyclesLeft--;
    }

    while (unused.length) {
        const node = unused.pop();
        const anchor = existing[rand(0, existing.length - 1)];
        edges.push([anchor, node]);
        existing.push(node);
    }
    return edges;
}

function getEdges_Bipartite(n, m, isDirected) {
    const set1 = [], set2 = [];
    for (let i = 1; i <= n; i++) (i <= Math.floor(n / 2) ? set1 : set2).push(i);
    const possible = [];
    for (const u of set1) {
        for (const v of set2) {
            possible.push([u, v]);
            if (isDirected) possible.push([v, u]);
        }
    }
    for (let i = possible.length - 1; i > 0; i--) {
        const j = rand(0, i);
        [possible[i], possible[j]] = [possible[j], possible[i]];
    }
    const target = Math.max(0, Math.min(Math.floor(Number(m) || 0), possible.length));
    return possible.slice(0, target);
}

function darkenHex(hex, factor = 0.2) { if (!hex || !hex.startsWith('#')) return hex; let r = parseInt(hex.substring(1, 3), 16), g = parseInt(hex.substring(3, 5), 16), b = parseInt(hex.substring(5, 7), 16); r = Math.max(0, Math.floor(r * (1 - factor))); g = Math.max(0, Math.floor(g * (1 - factor))); b = Math.max(0, Math.floor(b * (1 - factor))); return "#" + ((1 << 24) + (r << 16) + (g << 8) + b).toString(16).slice(1); }

let nodesDataset = null, edgesDataset = null, network = null, contextNodeId = null, contextEdgeId = null;
const PHYSICS_CONFIG = { gravitationalConstant: -8, centralGravity: 0.012, springConstant: 0.024, damping: 0.9 };
let physicsPausedForVisibility = false;
let physicsUpdateTimer = null;
let interactionMode = 'normal';
let pendingAddEdgeFrom = null;
const MIN_GRAPH_SCALE = 0.35;
const MAX_GRAPH_SCALE = 2.6;
let clampingZoom = false;

let isBCTreeMode = false;
let savedOriginalNodes = null;
let savedOriginalEdges = null;
let bcGeometricPositions = {}; 
let isBCTreeTreeLayout = false; 

window.forcePhysicsUpdate = function() {
    if (!network) return;
    if (document.hidden) {
        physicsPausedForVisibility = true;
        network.stopSimulation();
        network.setOptions({ physics: { enabled: false } });
        return;
    }
    const movableNodes = nodesDataset ? nodesDataset.get().some(node => !node.isPinned && node.shape !== 'square') : false;
    if (!movableNodes) {
        network.stopSimulation();
        network.setOptions({ physics: { enabled: false } });
        network.redraw();
        return;
    }
    const currentEdgeLen = parseInt(document.getElementById('edgeLength').value) || 40;
    const springLength = Math.max(16, Math.round(currentEdgeLen * 0.4125));
    physicsPausedForVisibility = false;
    network.setOptions({
        edges: { smooth: { enabled: false } },
        physics: {
            enabled: true,
            solver: 'forceAtlas2Based',
            forceAtlas2Based: Object.assign({}, PHYSICS_CONFIG, { springLength, avoidOverlap: 0.18 }),
            timestep: 0.25,
            maxVelocity: 8,
            minVelocity: 0.5,
            stabilization: { enabled: true, iterations: 100, updateInterval: 20, fit: false }
        }
    });
    network.startSimulation();
};

function applyPinnedLayout(positions) {
    if (!network || !nodesDataset) return;
    network.stopSimulation();
    network.setOptions({ layout: { hierarchical: { enabled: false } }, physics: { enabled: false }, edges: { smooth: { enabled: false } } });
    nodesDataset.update(nodesDataset.get().map(node => {
        const style = getStyleObject(node, { isPinned: true });
        const point = positions && positions[node.id];
        if (point && Number.isFinite(point.x) && Number.isFinite(point.y)) {
            style.x = point.x;
            style.y = point.y;
        }
        return style;
    }));
    refreshEditorPanel();
    network.redraw();
    network.fit({ animation: { duration: 450 } });
}

function getLayoutSpacing() {
    const value = parseInt(document.getElementById('edgeLength').value) || 40;
    return Math.max(52, Math.round(value * 1.2));
}

function computeCrossingReducedPositions(ids, edges, rootId) {
    const orderedIds = ids.map(String);
    const allowed = new Set(orderedIds);
    if (!orderedIds.length) return {};

    const adjacency = new Map(orderedIds.map(id => [id, new Set()]));
    for (const edge of edges) {
        const u = String(edge.from), v = String(edge.to);
        if (u === v || !allowed.has(u) || !allowed.has(v)) continue;
        adjacency.get(u).add(v);
        adjacency.get(v).add(u);
    }

    const levels = new Map();
    const starts = [rootId, ...orderedIds.filter(id => id !== rootId)];
    let componentBase = 0;
    for (const start of starts) {
        if (!allowed.has(start) || levels.has(start)) continue;
        const queue = [start];
        levels.set(start, componentBase);
        let componentMax = componentBase;
        for (let head = 0; head < queue.length; head++) {
            const u = queue[head];
            for (const v of adjacency.get(u)) {
                if (!levels.has(v)) {
                    levels.set(v, levels.get(u) + 1);
                    componentMax = Math.max(componentMax, levels.get(v));
                    queue.push(v);
                }
            }
        }
        componentBase = componentMax + 1;
    }

    const layers = [];
    for (const id of orderedIds) {
        const level = levels.get(id) || 0;
        if (!layers[level]) layers[level] = [];
        layers[level].push(id);
    }
    const originalOrder = new Map(orderedIds.map((id, i) => [id, i]));

    const ranks = () => {
        const result = new Map();
        layers.forEach(layer => {
            if (layer) layer.forEach((id, index) => result.set(id, index));
        });
        return result;
    };
    const barycenter = (id, neighborLevel, rankMap) => {
        const neighbors = Array.from(adjacency.get(id) || []).filter(v => levels.get(v) === neighborLevel);
        if (!neighbors.length) return null;
        return neighbors.reduce((sum, v) => sum + (rankMap.get(v) || 0), 0) / neighbors.length;
    };

    // Repeated barycentric sweeps reduce edge crossings between adjacent levels.
    for (let pass = 0; pass < 8; pass++) {
        for (let level = 1; level < layers.length; level++) {
            if (!layers[level]) continue;
            const rankMap = ranks();
            const previous = new Map(layers[level].map((id, i) => [id, i]));
            layers[level].sort((a, b) => {
                const ba = barycenter(a, level - 1, rankMap);
                const bb = barycenter(b, level - 1, rankMap);
                if (ba === null && bb === null) return previous.get(a) - previous.get(b);
                if (ba === null) return 1;
                if (bb === null) return -1;
                return (ba - bb) || (previous.get(a) - previous.get(b)) || (originalOrder.get(a) - originalOrder.get(b));
            });
        }
        for (let level = layers.length - 2; level >= 0; level--) {
            if (!layers[level]) continue;
            const rankMap = ranks();
            const previous = new Map(layers[level].map((id, i) => [id, i]));
            layers[level].sort((a, b) => {
                const ba = barycenter(a, level + 1, rankMap);
                const bb = barycenter(b, level + 1, rankMap);
                if (ba === null && bb === null) return previous.get(a) - previous.get(b);
                if (ba === null) return 1;
                if (bb === null) return -1;
                return (ba - bb) || (previous.get(a) - previous.get(b)) || (originalOrder.get(a) - originalOrder.get(b));
            });
        }
    }

    const gap = getLayoutSpacing();
    const horizontalGap = Math.round(gap * 1.5);
    const container = document.getElementById('mynetwork');
    const availableWidth = container && container.clientWidth ? container.clientWidth : 1000;
    const widthLimit = Math.max(1600, Math.min(2800, Math.floor(availableWidth * 2.0)));
    const maxColumns = Math.max(2, Math.floor(widthLimit / horizontalGap) + 1);
    const rowStep = Math.round(gap * 1.18);
    const layerGap = Math.round(gap * 0.9);
    const positions = {};
    let yCursor = 0;

    layers.forEach(layer => {
        if (!layer || !layer.length) return;
        const rowCount = Math.ceil(layer.length / maxColumns);
        for (let index = 0; index < layer.length; index++) {
            const row = Math.floor(index / maxColumns);
            const rowStart = row * maxColumns;
            const rowLength = Math.min(maxColumns, layer.length - rowStart);
            const column = index - rowStart;
            positions[layer[index]] = {
                x: (column - (rowLength - 1) / 2) * horizontalGap,
                y: yCursor + row * rowStep
            };
        }
        yCursor += rowCount * rowStep + layerGap;
    });
    return positions;
}


function computeSymmetricTreePositions(ids, edges, rootId) {
    const orderedIds = Array.from(new Set(ids.map(String)));
    const allowed = new Set(orderedIds);
    const compareIds = (a, b) => String(a).localeCompare(String(b), undefined, { numeric: true });
    const adjacency = new Map(orderedIds.map(id => [id, new Set()]));
    for (const edge of edges) {
        const u = String(edge.from), v = String(edge.to);
        if (u === v || !allowed.has(u) || !allowed.has(v)) continue;
        adjacency.get(u).add(v);
        adjacency.get(v).add(u);
    }

    const spacing = getLayoutSpacing();
    const horizontalGap = Math.max(72, Math.round(spacing * 1.65));
    const verticalGap = Math.max(76, Math.round(spacing * 1.3));
    const visited = new Set();

    function buildSubtree(u, parent) {
        visited.add(u);
        const children = Array.from(adjacency.get(u) || [])
            .filter(v => v !== parent && !visited.has(v))
            .sort(compareIds);
        const childTrees = children.map(id => ({ id, tree: buildSubtree(id, u) }));
        const coords = new Map([[u, { x: 0, y: 0 }]]);
        const placements = [];
        let cursor = 0;

        for (const child of childTrees) {
            const width = child.tree.maxX - child.tree.minX;
            const rootX = cursor - child.tree.minX;
            placements.push({ tree: child.tree, rootX });
            cursor += width + horizontalGap;
        }
        if (childTrees.length) cursor -= horizontalGap;

        let centerX = 0;
        if (placements.length === 1) centerX = placements[0].rootX;
        else if (placements.length > 1) centerX = (placements[0].rootX + placements[placements.length - 1].rootX) / 2;

        for (const placement of placements) {
            for (const [id, point] of placement.tree.coords) {
                coords.set(id, {
                    x: point.x + placement.rootX - centerX,
                    y: point.y + verticalGap
                });
            }
        }

        const xs = Array.from(coords.values(), point => point.x);
        return {
            coords,
            minX: Math.min(...xs),
            maxX: Math.max(...xs)
        };
    }

    const positions = {};
    let componentOffsetX = 0;
    const startIds = [String(rootId), ...orderedIds.filter(id => id !== String(rootId)).sort(compareIds)];
    for (const root of startIds) {
        if (!allowed.has(root) || visited.has(root)) continue;
        const tree = buildSubtree(root, null);
        const width = tree.maxX - tree.minX;
        const shiftX = componentOffsetX - tree.minX;
        for (const [id, point] of tree.coords) {
            positions[id] = { x: point.x + shiftX, y: point.y };
        }
        componentOffsetX += width + horizontalGap * 2;
    }

    const placed = Object.keys(positions);
    if (placed.length) {
        const minX = Math.min(...placed.map(id => positions[id].x));
        const maxX = Math.max(...placed.map(id => positions[id].x));
        const minY = Math.min(...placed.map(id => positions[id].y));
        const maxY = Math.max(...placed.map(id => positions[id].y));
        const cx = (minX + maxX) / 2;
        const cy = (minY + maxY) / 2;
        placed.forEach(id => {
            positions[id].x -= cx;
            positions[id].y -= cy;
        });
    }
    return positions;
}

function getStyleObject(node, updates) {
    node = node || {};
    const tc = THEME_COLORS[currentTheme];
    let isPinned = updates.isPinned !== undefined ? updates.isPinned : (node.isPinned || false);
    let customBorder = updates.customColor !== undefined ? updates.customColor : (node.customColor || '#000000');
    let actualBorder = customBorder.toLowerCase() === '#000000' ? tc.defaultNodeBorder : customBorder;
    let label = updates.label !== undefined ? updates.label : (node.label || '');
    let shape = updates.shape !== undefined ? updates.shape : (node.shape || 'circle');
    let hoverBorder = darkenHex(actualBorder, 0.2);

    let colorObj;
    if (shape === 'square') {
        colorObj = {
            background: tc.squareBg,
            border: tc.squareBorder,
            highlight: { background: tc.squareHighlight, border: tc.squareBorder },
            hover: { background: tc.squareHover, border: tc.squareBorder }
        };
    } else {
        colorObj = updates.color || {
            background: isPinned ? tc.nodeBgPinned : tc.nodeBg,
            border: actualBorder,
            highlight: { background: isPinned ? tc.nodeBgPinnedHighlight : tc.nodeBgHighlight, border: actualBorder },
            hover: { background: isPinned ? tc.nodeBgPinnedHover : tc.nodeBgHover, border: hoverBorder }
        };
    }

    return { id: node.id !== undefined ? node.id : updates.id, label: label, shape: shape, isPinned: isPinned, customColor: customBorder, fixed: isPinned ? { x: true, y: true } : { x: false, y: false }, borderWidth: isPinned ? 4 : 2, borderWidthSelected: isPinned ? 4 : 2, color: colorObj, shadow: isPinned ? { enabled: true, color: tc.shadowColor, size: 5, x: 1, y: 1 } : false };
}

function updateNodeStyle(nodeId, updates) { let node = nodesDataset.get(nodeId); if (!node) return; nodesDataset.update(getStyleObject(node, updates)); }

function initNetwork() {
    nodesDataset = new vis.DataSet(); edgesDataset = new vis.DataSet();
    const container = document.getElementById('mynetwork');
    const initNodeSize = parseInt(document.getElementById('nodeSize').value), initEdgeLength = parseInt(document.getElementById('edgeLength').value) || 40;
        const tc = THEME_COLORS[currentTheme];
    const options = {
        nodes: { shape: 'circle', mass: 12.0, borderWidth: 2, borderWidthSelected: 2, font: { color: tc.fontColor, size: initNodeSize, face: 'Arial, sans-serif' }, shadow: true },
        edges: { color: { color: tc.edgeColor, highlight: tc.edgeHighlight }, width: 2, font: { size: 14, align: 'top', color: tc.edgeFontColor, background: tc.edgeFontBg, strokeWidth: 3, strokeColor: tc.edgeFontStroke }, smooth: { enabled: false }, arrows: { to: { enabled: false, scaleFactor: 0.8 } } },
        physics: { enabled: true, solver: 'forceAtlas2Based', forceAtlas2Based: Object.assign({}, PHYSICS_CONFIG, { springLength: Math.max(16, Math.round(initEdgeLength * 0.4125)), avoidOverlap: 0.18 }), timestep: 0.25, maxVelocity: 8, minVelocity: 0.5, stabilization: { enabled: true, iterations: 100, updateInterval: 20, fit: false } },
        interaction: { hover: true, tooltipDelay: 200, multiselect: true }
    };
    network = new vis.Network(container, { nodes: nodesDataset, edges: edgesDataset }, options);
    network.on('stabilizationIterationsDone', function () {
        if (!network || document.hidden) return;
        network.stopSimulation();
        network.setOptions({ physics: { enabled: false } });
    });
    network.on('stabilized', function () {
        if (!network || document.hidden) return;
        network.stopSimulation();
        network.setOptions({ physics: { enabled: false } });
    });
    let pendingPinTimer = null;
    let suppressClickUntil = 0;
    network.on("click", function (params) {
        if (isBCTreeMode || Date.now() < suppressClickUntil) return;
        closeContextMenu();
        const clickedNode = params.nodes && params.nodes.length ? params.nodes[0] : undefined;
        const clickedEdge = params.edges && params.edges.length ? params.edges[0] : undefined;

        if (interactionMode === 'add') {
            if (pendingPinTimer) { clearTimeout(pendingPinTimer); pendingPinTimer = null; }
            if (clickedNode !== undefined) {
                const id = String(clickedNode);
                setEditorNodeSelection(id, true);
                if (pendingAddEdgeFrom === null) {
                    pendingAddEdgeFrom = id;
                    refreshEditorPanel(id, activeEditorEdgeId);
                } else if (pendingAddEdgeFrom === id) {
                    refreshEditorPanel(id, activeEditorEdgeId);
                } else {
                    const from = pendingAddEdgeFrom;
                    pendingAddEdgeFrom = null;
                    const newEdgeId = createEdgeBetween(from, id, '');
                    if (newEdgeId === null) refreshEditorPanel(id, activeEditorEdgeId);
                }
            } else if (clickedEdge === undefined) {
                pendingAddEdgeFrom = null;
                const point = params.pointer && params.pointer.canvas
                    ? params.pointer.canvas
                    : (params.pointer && params.pointer.DOM ? network.DOMtoCanvas(params.pointer.DOM) : null);
                if (point && Number.isFinite(point.x) && Number.isFinite(point.y)) addNodeAtCanvasPoint(point);
                else refreshEditorPanel();
            }
            return;
        }

        if (interactionMode === 'edit') {
            if (pendingPinTimer) { clearTimeout(pendingPinTimer); pendingPinTimer = null; }
            pendingAddEdgeFrom = null;
            if (clickedNode !== undefined) setEditorNodeSelection(String(clickedNode), true);
            else if (clickedEdge !== undefined) setEditorEdgeSelection(String(clickedEdge), true);
            return;
        }

        if (interactionMode === 'delete') {
            if (pendingPinTimer) { clearTimeout(pendingPinTimer); pendingPinTimer = null; }
            pendingAddEdgeFrom = null;
            if (clickedNode !== undefined) {
                setEditorNodeSelection(String(clickedNode), false);
                window.deleteSelectedNode();
            } else if (clickedEdge !== undefined) {
                setEditorEdgeSelection(String(clickedEdge), false);
                window.deleteSelectedEdge();
            }
            return;
        }

        if (clickedNode !== undefined) {
            const id = String(clickedNode);
            setEditorNodeSelection(id, false);
            if (pendingPinTimer) clearTimeout(pendingPinTimer);
            pendingPinTimer = setTimeout(() => {
                pendingPinTimer = null;
                if (interactionMode !== 'normal') return;
                const node = nodesDataset.get(id);
                if (!node) return;
                const nextPinned = !node.isPinned;
                updateNodeStyle(id, { isPinned: nextPinned });
                refreshEditorPanel(id, activeEditorEdgeId);
                window.forcePhysicsUpdate();
            }, 320);
        } else if (clickedEdge !== undefined) {
            if (pendingPinTimer) { clearTimeout(pendingPinTimer); pendingPinTimer = null; }
            setEditorEdgeSelection(String(clickedEdge), false);
        } else {
            if (pendingPinTimer) { clearTimeout(pendingPinTimer); pendingPinTimer = null; }
        }
    });
    network.on("doubleClick", function (params) {
        if (isBCTreeMode || interactionMode === 'add' || interactionMode === 'delete') return;
        if (pendingPinTimer) { clearTimeout(pendingPinTimer); pendingPinTimer = null; }
        const clickedNode = params.nodes && params.nodes.length ? params.nodes[0] : undefined;
        const clickedEdge = params.edges && params.edges.length ? params.edges[0] : undefined;
        if (clickedNode !== undefined) {
            const id = String(clickedNode);
            setEditorNodeSelection(id, false);
            openInlineNodeEditor(id);
        } else if (clickedEdge !== undefined) {
            if (interactionMode !== 'edit') window.setInteractionMode('edit');
            else ensureEditorPanelOpen();
            setEditorEdgeSelection(String(clickedEdge), false);
            ensureEditorPanelOpen();
            const edgeInput = document.getElementById('editEdgeLabel');
            if (edgeInput) { edgeInput.focus(); edgeInput.select(); }
        }
    });
    network.on("dragStart", function (params) {
        suppressClickUntil = Date.now() + 250;
        closeContextMenu();
        if (pendingPinTimer) { clearTimeout(pendingPinTimer); pendingPinTimer = null; }
        if (params.nodes && params.nodes.length > 0) {
            params.nodes.forEach(id => {
                const node = nodesDataset.get(id);
                if (node && node.isPinned) nodesDataset.update({ id: node.id, fixed: { x: false, y: false } });
            });
        }
    });
    network.on("dragging", function () { suppressClickUntil = Date.now() + 250; });
    network.on("dragEnd", function (params) {
        suppressClickUntil = Date.now() + 180;
        if (params.nodes && params.nodes.length > 0) {
            params.nodes.forEach(id => {
                const node = nodesDataset.get(id);
                if (node && node.isPinned) nodesDataset.update({ id: node.id, fixed: { x: true, y: true } });
            });
        }
        refreshEditorPanel(activeEditorNodeId, activeEditorEdgeId);
        window.forcePhysicsUpdate();
    });
    network.on("oncontext", function (params) { params.event.preventDefault(); closeContextMenu(); });
    network.on("zoom", function () {
        closeContextMenu();
        if (clampingZoom || !network) return;
        const scale = network.getScale();
        const bounded = Math.max(MIN_GRAPH_SCALE, Math.min(MAX_GRAPH_SCALE, scale));
        if (Math.abs(scale - bounded) > 0.001) {
            clampingZoom = true;
            network.moveTo({ position: network.getViewPosition(), scale: bounded, animation: false });
            clampingZoom = false;
        }
    });
}

function updateLayoutButtonsVisibility() {
    const treeBox = document.getElementById('treeLayoutBox');
    const bipBtn = document.getElementById('bipartiteLayoutBtn');
    const cactusBox = document.getElementById('cactusLayoutBox');
    const bcTreeBtn = document.getElementById('bcTreeBtn');
    if (!nodesDataset || !edgesDataset || !treeBox || !bipBtn || !cactusBox) return;

    const nodes = nodesDataset.get().filter(node => node.shape !== 'square').map(node => String(node.id));
    const edges = edgesDataset.get().filter(edge => !String(edge.from).startsWith('_square_') && !String(edge.to).startsWith('_square_'));
    const n = nodes.length;
    if (n === 0) {
        treeBox.style.display = 'none'; bipBtn.style.display = 'none'; cactusBox.style.display = 'none'; bcTreeBtn.style.display = 'none';
        return;
    }

    const adj = new Map(nodes.map(id => [id, new Set()]));
    const seenEdges = new Set();
    let edgeCount = 0;
    for (const edge of edges) {
        const u = String(edge.from), v = String(edge.to);
        if (!adj.has(u) || !adj.has(v)) continue;
        const key = u < v ? `${u}\u0000${v}` : `${v}\u0000${u}`;
        if (!seenEdges.has(key)) { seenEdges.add(key); edgeCount++; }
        adj.get(u).add(v); adj.get(v).add(u);
    }
    let bipartite = true;
    const colors = new Map();
    let components = 0;
    for (const start of nodes) {
        if (colors.has(start)) continue;
        components++;
        colors.set(start, 0);
        const queue = [start];
        for (let i = 0; i < queue.length; i++) {
            const u = queue[i];
            for (const v of adj.get(u)) {
                if (!colors.has(v)) { colors.set(v, 1 - colors.get(u)); queue.push(v); }
                else if (colors.get(v) === colors.get(u)) bipartite = false;
            }
        }
    }
    const isTree = components === 1 && edgeCount === n - 1;
    const blocks = getCactusBlocks(nodes, edges);
    const isCactus = components === 1 && edges.every(edge => String(edge.from) !== String(edge.to)) && blocks.every(block => block.type === 'bridge' || block.type === 'cycle');
    const isUndirected = document.getElementById('isDirected').value !== 'true';

    treeBox.style.display = isTree && isUndirected ? '' : 'none';
    bipBtn.style.display = bipartite ? '' : 'none';
    cactusBox.style.display = isCactus && isUndirected ? '' : 'none';
    bcTreeBtn.style.display = isCactus && isUndirected ? '' : 'none';
}

function calculateCactusPositions(nodes, edges) {
    const ids = Array.from(new Set(nodes.map(String)));
    const allowed = new Set(ids);
    const blocks = getCactusBlocks(ids, edges);
    if (blocks.some(block => block.type !== 'bridge' && block.type !== 'cycle')) return { pos: {}, blocks, valid: false };
    const nodeToBlocks = new Map(ids.map(id => [id, []]));
    blocks.forEach((block, index) => {
        block.nodes.forEach(id => {
            if (nodeToBlocks.has(id)) nodeToBlocks.get(id).push(index);
        });
    });

    const nodeChildren = new Map(ids.map(id => [id, []]));
    const blockChildren = new Map();
    const visitedNodes = new Set();
    const visitedBlocks = new Set();

    function orientFromNode(u) {
        if (visitedNodes.has(u)) return;
        visitedNodes.add(u);
        for (const blockIndex of nodeToBlocks.get(u) || []) {
            if (visitedBlocks.has(blockIndex)) continue;
            visitedBlocks.add(blockIndex);
            nodeChildren.get(u).push(blockIndex);
            const childNodes = blocks[blockIndex].nodes.filter(v => v !== u && allowed.has(v) && !visitedNodes.has(v));
            blockChildren.set(blockIndex, childNodes);
            childNodes.forEach(orientFromNode);
        }
    }

    // Root the block-cut forest at an articulation node, so each cycle is a real polygon block.
    const roots = ids.slice().sort((a, b) => {
        const deg = (nodeToBlocks.get(b) || []).length - (nodeToBlocks.get(a) || []).length;
        return deg || ids.indexOf(a) - ids.indexOf(b);
    });
    roots.forEach(root => { if (!visitedNodes.has(root)) orientFromNode(root); });

    const nodeWeightMemo = new Map();
    const blockWeightMemo = new Map();
    function nodeWeight(u) {
        if (nodeWeightMemo.has(u)) return nodeWeightMemo.get(u);
        let total = 1;
        for (const blockIndex of nodeChildren.get(u) || []) total += blockWeight(blockIndex);
        nodeWeightMemo.set(u, total);
        return total;
    }
    function blockWeight(blockIndex) {
        if (blockWeightMemo.has(blockIndex)) return blockWeightMemo.get(blockIndex);
        let total = 0;
        for (const v of blockChildren.get(blockIndex) || []) total += nodeWeight(v);
        blockWeightMemo.set(blockIndex, total);
        return total;
    }

    const spacing = Math.max(120, Math.round(getLayoutSpacing() * 2.2));
    const positions = {};
    let componentOffsetX = 0;

    function placeNode(u, baseAngle, angleRange) {
        const childBlocks = nodeChildren.get(u) || [];
        if (!childBlocks.length) return;
        const weights = childBlocks.map(blockWeight);
        const totalWeight = weights.reduce((sum, weight) => sum + weight, 0) || childBlocks.length;
        let cursor = baseAngle - angleRange / 2;

        childBlocks.forEach((blockIndex, index) => {
            const block = blocks[blockIndex];
            const weight = weights[index] || 1;
            const sector = childBlocks.length === 1 ? angleRange : angleRange * weight / totalWeight;
            const angle = cursor + sector / 2;
            const childNodes = blockChildren.get(blockIndex) || [];

            if (block.type === 'bridge') {
                const v = childNodes[0] || block.nodes.find(id => id !== u);
                if (v && !positions[v]) {
                    positions[v] = { x: positions[u].x + spacing * Math.cos(angle), y: positions[u].y + spacing * Math.sin(angle) };
                    placeNode(v, angle, sector);
                }
            } else {
                const cycle = block.nodes.slice();
                const rootIndex = cycle.indexOf(u);
                if (rootIndex >= 0) cycle.push(...cycle.splice(0, rootIndex));
                const k = cycle.length;
                if (k >= 3) {
                    const radius = spacing / (2 * Math.sin(Math.PI / k));
                    const centerX = positions[u].x + radius * Math.cos(angle);
                    const centerY = positions[u].y + radius * Math.sin(angle);
                    const theta0 = angle + Math.PI;
                    const cycleAngles = new Map([[u, theta0]]);

                    for (let i = 1; i < k; i++) {
                        const v = cycle[i];
                        const theta = theta0 + i * 2 * Math.PI / k;
                        cycleAngles.set(v, theta);
                        if (!positions[v]) {
                            positions[v] = {
                                x: centerX + radius * Math.cos(theta),
                                y: centerY + radius * Math.sin(theta)
                            };
                        }
                    }

                    // Each cycle is drawn as a ring; branches leave its vertices outwards.
                    const branchRange = Math.min(Math.PI * 1.2, Math.max(0.32, sector / Math.max(1, k - 1)));
                    for (let i = 1; i < k; i++) {
                        const v = cycle[i];
                        if (positions[v]) placeNode(v, cycleAngles.get(v), branchRange);
                    }
                }
            }
            cursor += sector;
        });
    }

    for (const root of roots) {
        if (positions[root]) continue;
        const before = new Set(Object.keys(positions));
        positions[root] = { x: componentOffsetX, y: 0 };
        placeNode(root, 0, Math.PI * 2);
        const componentNodes = ids.filter(id => !before.has(id) && positions[id]);
        if (componentNodes.length) {
            const minX = componentNodes.reduce((min, id) => Math.min(min, positions[id].x), Infinity);
            const shiftX = componentOffsetX - minX;
            componentNodes.forEach(id => { positions[id].x += shiftX; });
            const maxX = componentNodes.reduce((max, id) => Math.max(max, positions[id].x), -Infinity);
            componentOffsetX = maxX + spacing * 3;
        }
    }

    // Keep coordinates centered around the whole graph to avoid one-sided placements.
    const placed = ids.filter(id => positions[id]);
    if (placed.length) {
        const minX = Math.min(...placed.map(id => positions[id].x));
        const maxX = Math.max(...placed.map(id => positions[id].x));
        const minY = Math.min(...placed.map(id => positions[id].y));
        const maxY = Math.max(...placed.map(id => positions[id].y));
        const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;
        placed.forEach(id => { positions[id].x -= cx; positions[id].y -= cy; });
    }
    return { pos: positions, blocks, valid: true };
}

window.formatAsCactus = function() {
    if (!network || !nodesDataset) return;
    const nodes = nodesDataset.getIds().map(String).filter(id => {
        const node = nodesDataset.get(id);
        return node && node.shape !== 'square';
    });
    const edges = edgesDataset.get();
    if (!nodes.length) return;
    const result = calculateCactusPositions(nodes, edges);
    if (!result.valid) { alert('当前图不是仙人掌图：每个双连通块必须是单条边或一个简单环。'); return; }
    applyPinnedLayout(result.pos);
}

window.toggleBCTreeMode = function() {
    const btn = document.getElementById('bcTreeBtn');
    const layoutBox = document.getElementById('bcTreeLayoutBox');

    if (isBCTreeMode) {
        isBCTreeMode = false;
        btn.innerText = "圆方树展示";
        btn.style.backgroundColor = ""; 
        layoutBox.style.display = "none"; 
        bcGeometricPositions = {};
        setUIElementsLock(false);
        
        nodesDataset.clear(); edgesDataset.clear();
        nodesDataset.add(savedOriginalNodes);
        edgesDataset.add(savedOriginalEdges);
        savedOriginalNodes = null; savedOriginalEdges = null;
        window.formatAsCactus();
        return;
    }

    window.setInteractionMode('normal');
    isBCTreeMode = true;
    isBCTreeTreeLayout = false; 
    btn.innerText = "取消";
    btn.style.backgroundColor = ""; 
    
    layoutBox.style.display = "flex";
    document.getElementById('bcTreeLayoutBtn').innerText = "树";
    setUIElementsLock(true);

    let nodesStr = nodesDataset.getIds().map(String);
    let originalEdges = edgesDataset.get();

    let defaultRoot = nodesStr.includes("1") ? "1" : nodesStr[0];
    document.getElementById('bcTreeRootInput').value = defaultRoot;

    let { pos, blocks } = calculateCactusPositions(nodesStr, originalEdges);
    let currentPositions = network.getPositions();
    savedOriginalNodes = nodesDataset.get().map(n => { 
        let clone = Object.assign({}, n); 
        if(currentPositions[n.id]) { clone.x = currentPositions[n.id].x; clone.y = currentPositions[n.id].y; } 
        return clone; 
    });
    savedOriginalEdges = originalEdges;

    let newNodes = [], newEdges = [];
    savedOriginalNodes.forEach(n => {
        let clone = Object.assign({}, n);
        clone.shape = 'circle'; 
        clone.isPinned = true;
        clone.fixed = {x: true, y: true}; 
        if (pos[n.id]) { clone.x = pos[n.id].x; clone.y = pos[n.id].y; }
        Object.assign(clone, getStyleObject(clone, { shape: 'circle', isPinned: true }));
        newNodes.push(clone);
    });

    let baseSize = parseInt(document.getElementById('nodeSize').value) || 20;

    blocks.forEach((b, i) => {
        let sqId = `_square_${i}`;
        let cx = 0, cy = 0;
        b.nodes.forEach(u => { cx += pos[u].x; cy += pos[u].y; });
        cx /= b.nodes.length; cy /= b.nodes.length;

        const tc = THEME_COLORS[currentTheme];
        newNodes.push({
            id: sqId, label: '', shape: 'square',
            size: baseSize * 0.7,
            color: { background: tc.squareBg, border: tc.squareBorder, highlight: { background: tc.squareHighlight, border: tc.squareBorder }, hover: { background: tc.squareHover, border: tc.squareBorder } },
            borderWidth: 3, borderWidthSelected: 4,
            fixed: {x: true, y: true},
            x: cx, y: cy,
            isPinned: true,
            shadow: { enabled: true, color: tc.shadowColor, size: 6, x: 1, y: 1 }
        });

        b.nodes.forEach(u => {
            newEdges.push({ from: sqId, to: u, color: { color: THEME_COLORS[currentTheme].blockEdgeColor, highlight: THEME_COLORS[currentTheme].edgeHighlight }, width: 2, dashes: true, smooth: { enabled: false } });
        });
    });

    edgesDataset.clear(); nodesDataset.clear();
    nodesDataset.add(newNodes); edgesDataset.add(newEdges);
    
    bcGeometricPositions = {};
    newNodes.forEach(n => { bcGeometricPositions[n.id] = { x: n.x, y: n.y }; });

    network.setOptions({ physics: { enabled: false } }); 
    network.fit({ animation: { duration: 600 } });
}

window.applyBCTreeTreeLayout = function() {
    let nodes = nodesDataset.getIds();
    let rootId = document.getElementById('bcTreeRootInput').value.trim();
    
    if (!rootId || !nodes.includes(rootId)) {
        alert(`未在当前图中找到节点 [${rootId}]！\n你可以输入任意圆点编号，或方点编号（如 _square_0）。`);
        return false;
    }

    let adj = {}; nodes.forEach(id => adj[id] = []);
    edgesDataset.get().forEach(e => { adj[e.from].push(e.to); adj[e.to].push(e.from); });

    let levels = {}, q = [rootId]; levels[rootId] = 0;
    while (q.length > 0) {
        let curr = q.shift();
        for (let nbr of adj[curr]) {
            if (levels[nbr] === undefined) { levels[nbr] = levels[curr] + 1; q.push(nbr); }
        }
    }

    nodesDataset.update(nodesDataset.get().map(n => ({ id: n.id, level: levels[n.id] !== undefined ? levels[n.id] : 0 })));

    const currentEdgeLen = parseInt(document.getElementById('edgeLength').value) || 40;
    network.setOptions({
        layout: { 
            hierarchical: { 
                enabled: true, 
                direction: 'UD', 
                sortMethod: 'directed', 
                nodeSpacing: currentEdgeLen * 1.55,
                levelSeparation: currentEdgeLen * 1.75
            } 
        },
        physics: { enabled: false }
    });

    setTimeout(() => {
        let positions = network.getPositions();
        network.setOptions({ layout: { hierarchical: { enabled: false } } });
        nodesDataset.update(nodesDataset.get().map(node => {
            let style = getStyleObject(node, { isPinned: true });
            if (positions[node.id]) { style.x = positions[node.id].x; style.y = positions[node.id].y; }
            return style;
        }));
        network.fit({ animation: { duration: 600 } });
    }, 50);

    return true;
}

window.toggleBCTreeLayout = function() {
    if (!network || !nodesDataset || !isBCTreeMode) return;
    const btn = document.getElementById('bcTreeLayoutBtn');

    if (isBCTreeTreeLayout) {
        network.setOptions({ layout: { hierarchical: { enabled: false } }, physics: { enabled: false } });
        let updates = nodesDataset.get().map(node => {
            let style = getStyleObject(node, { isPinned: true });
            if (bcGeometricPositions[node.id]) {
                style.x = bcGeometricPositions[node.id].x;
                style.y = bcGeometricPositions[node.id].y;
            }
            return style;
        });
        nodesDataset.update(updates);
        network.fit({ animation: { duration: 600 } });
        
        btn.innerText = "树";
        isBCTreeTreeLayout = false;
    } else {
        if (applyBCTreeTreeLayout()) {
            btn.innerText = "取消";
            isBCTreeTreeLayout = true;
        }
    }
}

window.updateBCTreeLayoutRoot = function() {
    if (isBCTreeMode && isBCTreeTreeLayout) {
        applyBCTreeTreeLayout();
    }
}

function setUIElementsLock(locked) {
    document.getElementById('output').disabled = locked;
    document.getElementById('n').disabled = locked;
    document.getElementById('m').disabled = locked;
    document.getElementById('graphStructure').disabled = locked;
    document.getElementById('isDirected').disabled = locked;
    document.getElementById('isWeighted').disabled = locked;
    document.getElementById('btnGenerate').disabled = locked;
    
    let opacity = locked ? '0.4' : '1';
    let ptrEvents = locked ? 'none' : 'auto';
    
    const elementsToLock = ['treeLayoutBox', 'cactusLayoutBox', 'bipartiteLayoutBtn', 'nodeSize', 'edgeLength', 'modeAddBtn', 'modeEditBtn', 'modeDeleteBtn'];
    elementsToLock.forEach(id => {
        let el = document.getElementById(id);
        if (el) {
            el.style.opacity = opacity;
            el.style.pointerEvents = ptrEvents;
            if (id === 'modeAddBtn' || id === 'modeEditBtn' || id === 'modeDeleteBtn') el.disabled = locked;
        }
    });
    const editorContent = document.getElementById('editorContent');
    if (editorContent) { editorContent.style.opacity = opacity; editorContent.style.pointerEvents = ptrEvents; }
}

function getCactusBlocks(nodes, edges) {
    const ids = Array.from(new Set(nodes.map(String)));
    const adjacency = new Map(ids.map(id => [id, []]));
    const uniqueEdges = [];
    const seenKeys = new Set();
    let hasSelfLoop = false;
    const edgeKey = (u, v) => u < v ? `${u}\u0000${v}` : `${v}\u0000${u}`;

    for (const edge of edges) {
        const u = String(edge.from), v = String(edge.to);
        if (!adjacency.has(u) || !adjacency.has(v)) continue;
        if (u === v) { hasSelfLoop = true; continue; }
        const key = edgeKey(u, v);
        if (seenKeys.has(key)) continue;
        seenKeys.add(key);
        uniqueEdges.push({ u, v, key });
        adjacency.get(u).push({ to: v, key });
        adjacency.get(v).push({ to: u, key });
    }

    const discovery = new Map();
    const low = new Map();
    const edgeStack = [];
    const blocks = [];
    let timer = 0;

    function addBlock(blockEdges) {
        if (!blockEdges.length) return;
        const degree = new Map();
        const localAdj = new Map();
        for (const edge of blockEdges) {
            degree.set(edge.u, (degree.get(edge.u) || 0) + 1);
            degree.set(edge.v, (degree.get(edge.v) || 0) + 1);
            if (!localAdj.has(edge.u)) localAdj.set(edge.u, []);
            if (!localAdj.has(edge.v)) localAdj.set(edge.v, []);
            localAdj.get(edge.u).push(edge.v);
            localAdj.get(edge.v).push(edge.u);
        }
        const blockNodes = Array.from(degree.keys());
        if (blockEdges.length === 1 && blockNodes.length === 2) {
            blocks.push({ type: 'bridge', nodes: [blockEdges[0].u, blockEdges[0].v], edges: blockEdges });
            return;
        }
        const isCycle = blockEdges.length === blockNodes.length && blockNodes.every(id => degree.get(id) === 2);
        if (!isCycle || blockNodes.length < 3) {
            blocks.push({ type: 'invalid', nodes: blockNodes, edges: blockEdges });
            return;
        }
        const cycleNodes = [];
        const start = blockNodes[0];
        let previous = null, current = start;
        do {
            cycleNodes.push(current);
            const neighbors = localAdj.get(current) || [];
            const next = neighbors.find(id => id !== previous);
            previous = current;
            current = next;
        } while (current && current !== start && cycleNodes.length <= blockNodes.length);
        if (current !== start || cycleNodes.length !== blockNodes.length) {
            blocks.push({ type: 'invalid', nodes: blockNodes, edges: blockEdges });
        } else {
            blocks.push({ type: 'cycle', nodes: cycleNodes, edges: blockEdges });
        }
    }

    function dfs(u, parentEdgeKey) {
        discovery.set(u, ++timer);
        low.set(u, discovery.get(u));
        for (const item of adjacency.get(u) || []) {
            const v = item.to;
            if (item.key === parentEdgeKey) continue;
            if (!discovery.has(v)) {
                edgeStack.push({ u, v, key: item.key });
                dfs(v, item.key);
                low.set(u, Math.min(low.get(u), low.get(v)));
                if (low.get(v) >= discovery.get(u)) {
                    const componentEdges = [];
                    let popped;
                    do {
                        popped = edgeStack.pop();
                        if (popped) componentEdges.push(popped);
                    } while (popped && popped.key !== item.key);
                    addBlock(componentEdges);
                }
            } else if (discovery.get(v) < discovery.get(u)) {
                edgeStack.push({ u, v, key: item.key });
                low.set(u, Math.min(low.get(u), discovery.get(v)));
            }
        }
    }

    for (const id of ids) {
        if (!discovery.has(id)) {
            dfs(id, null);
            if (edgeStack.length) addBlock(edgeStack.splice(0));
        }
    }
    if (hasSelfLoop) blocks.push({ type: 'invalid', nodes: [], edges: [] });
    return blocks;
}

function inferGraphStructure(nodeIds, edgeList, directed) {
    const ids = Array.from(nodeIds, String);
    const n = ids.length;
    if (n === 0) return 'graph';

    const adj = new Map(ids.map(id => [id, new Set()]));
    const pairs = new Set();
    let hasSelfLoop = false;
    for (const edge of edgeList) {
        const u = String(edge.from), v = String(edge.to);
        if (u === v) { hasSelfLoop = true; continue; }
        const a = u < v ? u : v, b = u < v ? v : u;
        const key = `${a}\u0000${b}`;
        if (pairs.has(key)) continue;
        pairs.add(key);
        if (adj.has(u)) adj.get(u).add(v);
        if (adj.has(v)) adj.get(v).add(u);
    }

    const m = pairs.size;
    let components = 0;
    const seen = new Set();
    for (const start of ids) {
        if (seen.has(start)) continue;
        components++;
        const queue = [start];
        seen.add(start);
        for (let i = 0; i < queue.length; i++) {
            const u = queue[i];
            for (const v of adj.get(u) || []) {
                if (!seen.has(v)) { seen.add(v); queue.push(v); }
            }
        }
    }
    const connected = components === 1;
    const treeShape = !hasSelfLoop && connected && m === n - 1;
    const degrees = ids.map(id => (adj.get(id) || new Set()).size);

    // The requested priority is: chain > daisy/star > tree > bipartite > general graph.
    // Directed graphs are not auto-labelled as chain/tree because those generator types are undirected.
    if (!directed && treeShape && degrees.every(d => d <= 2)) return 'chain';
    if (!directed && treeShape && n >= 3 && degrees.filter(d => d === n - 1).length === 1 && degrees.every(d => d === 1 || d === n - 1)) return 'daisy';
    if (!directed && treeShape) return 'tree';

    let bipartite = !hasSelfLoop;
    const color = new Map();
    for (const start of ids) {
        if (color.has(start)) continue;
        color.set(start, 0);
        const queue = [start];
        for (let i = 0; i < queue.length; i++) {
            const u = queue[i];
            for (const v of adj.get(u) || []) {
                if (!color.has(v)) { color.set(v, 1 - color.get(u)); queue.push(v); }
                else if (color.get(v) === color.get(u)) bipartite = false;
            }
        }
    }
    return bipartite ? 'bipartite' : 'graph';
}

function syncGraphControls(nodeIds, edgeList, syncStructure = true) {
    const nInput = document.getElementById('n');
    const mInput = document.getElementById('m');
    const maxwInput = document.getElementById('maxw');
    const structureInput = document.getElementById('graphStructure');
    const directedInput = document.getElementById('isDirected');
    const weightedInput = document.getElementById('isWeighted');
    const n = nodeIds.size;
    nInput.value = n;
    mInput.value = edgeList.length;

    const numberPattern = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/;
    if (edgeList.length) {
        const labels = edgeList.map(edge => edge.label === undefined ? '' : String(edge.label).trim());
        const numericLabels = labels.filter(label => label !== '');
        const allPresentLabelsAreNumeric = numericLabels.length > 0 && numericLabels.every(label => numberPattern.test(label));
        weightedInput.value = allPresentLabelsAreNumeric ? 'true' : 'false';
        if (allPresentLabelsAreNumeric) {
            const maxWeight = Math.max(1, ...numericLabels.map(label => Math.ceil(Math.abs(Number(label)))));
            maxwInput.value = maxWeight;
        }
    } else {
        weightedInput.value = 'false';
    }
    maxwInput.disabled = weightedInput.value === 'false';

    if (syncStructure) structureInput.value = inferGraphStructure(nodeIds, edgeList, directedInput.value === 'true');
    const structure = structureInput.value;
    const fixedEdges = ['tree', 'chain', 'daisy', 'binary'].includes(structure);
    if (fixedEdges) {
        mInput.disabled = true;
        mInput.min = 0;
        mInput.max = Math.max(0, n - 1);
        mInput.value = Math.max(0, n - 1);
        directedInput.value = 'false';
        directedInput.disabled = true;
    } else if (structure === 'cactus') {
        directedInput.value = 'false';
        directedInput.disabled = true;
        mInput.disabled = false;
        mInput.min = n > 0 ? n - 1 : 0;
        mInput.max = n > 0 ? n - 1 + Math.floor((n - 1) / 2) : 0;
        const currentM = parseInt(mInput.value);
        if (Number.isNaN(currentM) || currentM < Number(mInput.min)) mInput.value = mInput.min;
        if (currentM > Number(mInput.max)) mInput.value = mInput.max;
    } else {
        mInput.disabled = false;
        directedInput.disabled = false;
        mInput.min = 0;
        mInput.max = directedInput.value === 'true' ? n * Math.max(0, n - 1) : Math.min(10000, n * Math.max(0, n - 1) / 2);
    }
    updateMHint();
}

window.renderGraphFromText = function(syncControls = true, syncStructure = true) {
    if (isBCTreeMode) return;
    if (!nodesDataset || !edgesDataset) return;
    const text = document.getElementById('output').value.trim();
    const lines = text ? text.split('\n').map(l => l.trim()).filter(l => l !== '') : [];

    // If the input explicitly contains both u->v and v->u, treat it as directed data.
    const forwardPairs = new Set();
    let hasReversePair = false;
    for (const line of lines) {
        const parts = line.split(/\s+/);
        if (parts.length < 2) continue;
        const u = String(parts[0]), v = String(parts[1]);
        if (forwardPairs.has(`${v}\u0000${u}`)) hasReversePair = true;
        forwardPairs.add(`${u}\u0000${v}`);
    }
    const directedInput = document.getElementById('isDirected');
    if (syncControls && hasReversePair) directedInput.value = 'true';
    let isDirected = directedInput.value === 'true';
    network.setOptions({ edges: { arrows: { to: { enabled: isDirected } } } });

    if (!lines.length) {
        nodesDataset.clear();
        edgesDataset.clear();
        if (syncControls) syncGraphControls(new Set(), [], syncStructure);
        updateLayoutButtonsVisibility();
        refreshEditorPanel(null, null);
        return;
    }

    let uniqueNodes = new Set(), newEdges = [];
    let seenEdges = new Set(); 

    lines.forEach(line => {
        const parts = line.split(/\s+/);
        if (parts.length === 1) { 
            uniqueNodes.add(parts[0]); 
        } 
        else if (parts.length >= 2) {
            let u = String(parts[0]), v = String(parts[1]);
            uniqueNodes.add(u); uniqueNodes.add(v);
            
            let edgeKey = isDirected ? `${u}->${v}` : (u < v ? `${u}-${v}` : `${v}-${u}`);
            
            if (!seenEdges.has(edgeKey)) {
                seenEdges.add(edgeKey);
                let edge = { from: u, to: v };
                if (parts.length >= 3) edge.label = parts.slice(2).join(' ');
                newEdges.push(edge);
            }
        }
    });

    let currentIds = new Set(nodesDataset.getIds().map(String));
    let nodesToAdd = [];
    uniqueNodes.forEach(id => { if (!currentIds.has(id)) nodesToAdd.push(getStyleObject({ id: id, label: id }, {})); });
    let nodeIdsToRemove = Array.from(currentIds).filter(id => !uniqueNodes.has(id));
    if (nodeIdsToRemove.length > 0) nodesDataset.remove(nodeIdsToRemove);
    if (nodesToAdd.length > 0) nodesDataset.add(nodesToAdd);

    edgesDataset.clear(); edgesDataset.add(newEdges);
    if (syncControls) syncGraphControls(uniqueNodes, newEdges, syncStructure);
    const syncedDirected = document.getElementById('isDirected').value === 'true';
    network.setOptions({ edges: { arrows: { to: { enabled: syncedDirected } } } });
    updateLayoutButtonsVisibility();
    refreshEditorPanel();
    setTimeout(() => { window.forcePhysicsUpdate(); }, 10);
}

document.addEventListener('keydown', e => {
    if (e.key === 'Escape') closeContextMenu();
});

window.updateNodeSize = function(val) { if(network) { network.setOptions({ nodes: { font: { size: parseInt(val) } } }); } }
window.updateEdgeLength = function(val) { if (physicsUpdateTimer) clearTimeout(physicsUpdateTimer); physicsUpdateTimer = setTimeout(() => { physicsUpdateTimer = null; window.forcePhysicsUpdate(); }, 110); }
window.pinAll = function() { if(!nodesDataset) return; nodesDataset.update(nodesDataset.get().map(node => getStyleObject(node, { isPinned: true }))); refreshEditorPanel(); window.forcePhysicsUpdate(); }
window.unpinAll = function() { if(!nodesDataset) return; nodesDataset.update(nodesDataset.get().map(node => getStyleObject(node, { isPinned: false }))); refreshEditorPanel(); window.forcePhysicsUpdate(); }

window.formatAsTree = function() {
    if (!network || !nodesDataset || !nodesDataset.getIds().length) return;
    const ids = nodesDataset.getIds().map(String).filter(id => {
        const node = nodesDataset.get(id);
        return node && node.shape !== 'square';
    });
    if (!ids.length) return;
    let rootId = document.getElementById('treeRootInput').value.trim();
    if (!ids.includes(rootId)) rootId = ids.includes('1') ? '1' : ids[0];
    document.getElementById('treeRootInput').value = rootId;
    const treeEdges = edgesDataset.get();
    let positions = computeSymmetricTreePositions(ids, treeEdges, rootId);
    const xs = Object.values(positions).map(point => point.x);
    const canvas = document.getElementById('mynetwork');
    const availableWidth = canvas && canvas.clientWidth ? canvas.clientWidth : 1000;
    const widthLimit = Math.max(1600, Math.min(2800, Math.floor(availableWidth * 2.0)));
    if (xs.length && Math.max(...xs) - Math.min(...xs) > widthLimit) {
        positions = computeCrossingReducedPositions(ids, treeEdges, rootId);
    }
    applyPinnedLayout(positions);
};

window.formatAsBipartite = function() {
    if (!network || !nodesDataset || !nodesDataset.getIds().length) return;
    const ids = nodesDataset.getIds().map(String).filter(id => {
        const node = nodesDataset.get(id);
        return node && node.shape !== 'square';
    });
    const adj = new Map(ids.map(id => [id, []]));
    edgesDataset.get().forEach(edge => {
        const u = String(edge.from), v = String(edge.to);
        if (u !== v && adj.has(u) && adj.has(v)) { adj.get(u).push(v); adj.get(v).push(u); }
    });
    const color = new Map();
    for (const start of ids) {
        if (color.has(start)) continue;
        color.set(start, 0);
        const queue = [start];
        for (let head = 0; head < queue.length; head++) {
            const u = queue[head];
            for (const v of adj.get(u) || []) {
                if (!color.has(v)) { color.set(v, 1 - color.get(u)); queue.push(v); }
            }
        }
    }
    const groups = [[], []];
    ids.forEach(id => groups[color.get(id) || 0].push(id));
    const gap = getLayoutSpacing();
    const positions = {};
    groups.forEach((group, side) => {
        const span = (group.length - 1) * gap;
        group.forEach((id, index) => {
            positions[id] = { x: (side === 0 ? -1 : 1) * gap * 1.25, y: index * gap - span / 2 };
        });
    });
    applyPinnedLayout(positions);
};

window.closeContextMenu = function() {
    contextNodeId = null;
    contextEdgeId = null;
};

let activeEditorNodeId = null;
let activeEditorEdgeId = null;

function nodeById(id) {
    if (id === null || id === undefined || id === '') return null;
    return nodesDataset ? (nodesDataset.get(id) || nodesDataset.get(String(id))) : null;
}

function edgeByUiId(id) {
    if (!edgesDataset || id === null || id === undefined || id === '') return null;
    const numericId = Number(id);
    return edgesDataset.get(Number.isNaN(numericId) ? id : numericId) || edgesDataset.get(id) || null;
}

function fillSelect(select, items, selectedValue, emptyText, valueOf, labelOf) {
    if (!select) return;
    select.replaceChildren();
    if (!items.length) {
        select.add(new Option(emptyText, ''));
        select.value = '';
        return;
    }
    items.forEach(item => select.add(new Option(labelOf(item), String(valueOf(item)))));
    const desired = selectedValue === null || selectedValue === undefined ? '' : String(selectedValue);
    select.value = items.some(item => String(valueOf(item)) === desired) ? desired : String(valueOf(items[0]));
}

function refreshEditorPanel(preferredNodeId = activeEditorNodeId, preferredEdgeId = activeEditorEdgeId) {
    if (!nodesDataset || !edgesDataset) return;
    const nodeList = nodesDataset.get().filter(node => node.shape !== 'square').sort((a, b) => String(a.id).localeCompare(String(b.id), 'zh-CN', { numeric: true }));
    const edgeList = edgesDataset.get();
    let nodeId = preferredNodeId !== null && preferredNodeId !== undefined && nodeById(preferredNodeId) ? String(preferredNodeId) : null;
    if (nodeId === null && nodeList.length) nodeId = String(nodeList[0].id);
    let edgeId = preferredEdgeId !== null && preferredEdgeId !== undefined && edgeByUiId(preferredEdgeId) ? String(preferredEdgeId) : null;
    if (edgeId === null && edgeList.length) edgeId = String(edgeList[0].id);

    activeEditorNodeId = nodeId;
    activeEditorEdgeId = edgeId;
    fillSelect(document.getElementById('editNodeSelect'), nodeList, nodeId, '暂无节点', node => node.id, node => `${node.label || node.id}${node.isPinned ? '（已固定）' : ''}`);
    fillSelect(document.getElementById('newEdgeFrom'), nodeList, document.getElementById('newEdgeFrom')?.value || nodeId, '暂无节点', node => node.id, node => String(node.label || node.id));
    fillSelect(document.getElementById('newEdgeTo'), nodeList, document.getElementById('newEdgeTo')?.value || (nodeList[1] ? nodeList[1].id : nodeId), '暂无节点', node => node.id, node => String(node.label || node.id));
    fillSelect(document.getElementById('editEdgeSelect'), edgeList, edgeId, '暂无边', edge => edge.id, edge => `${edge.from} → ${edge.to}${edge.label ? '  (' + edge.label + ')' : ''}`);

    const node = nodeById(nodeId);
    const nameInput = document.getElementById('editNodeName');
    const colorInput = document.getElementById('editNodeColor');
    const colorText = document.getElementById('editNodeColorText');
    if (node) {
        nameInput.value = String(node.label || node.id);
        colorInput.value = /^#[0-9a-f]{6}$/i.test(node.customColor || '') ? node.customColor : '#000000';
        colorText.textContent = colorInput.value.toUpperCase();
    } else {
        nameInput.value = '';
        colorInput.value = '#000000';
        colorText.textContent = '#000000';
    }
    const edge = edgeByUiId(edgeId);
    document.getElementById('editEdgeLabel').value = edge ? (edge.label || '') : '';
    const hint = document.getElementById('editorHint');
    if (interactionMode === 'add') {
        hint.textContent = pendingAddEdgeFrom === null
            ? '添加模式：单击空白处创建节点，依次单击两个节点创建无权边。'
            : `添加模式：已选择起点「${pendingAddEdgeFrom}」，再单击另一个节点创建无权边。`;
    } else if (interactionMode === 'edit') {
        hint.textContent = node ? `正在编辑节点「${node.id}」；单击边可切换到边属性，双击边可直接编辑边权。` : '编辑模式：单击节点或边以选择并修改属性。';
    } else if (interactionMode === 'delete') {
        hint.textContent = '删除模式：单击节点会删除节点及关联边；单击边会删除该边。';
    } else {
        hint.textContent = node ? `当前节点：${node.id}。单击节点固定/解除固定；拖动不会切换固定状态。双击节点可直接改名。` : '普通模式：单击节点固定/解除固定；双击节点改名，双击边编辑边权。';
    }
}

function setEditorNodeSelection(id, selectOnCanvas = true) {
    if (!nodeById(id)) return;
    activeEditorNodeId = String(id);
    refreshEditorPanel(activeEditorNodeId, activeEditorEdgeId);
    if (selectOnCanvas && network) network.selectNodes([id]);
}

function setEditorEdgeSelection(id, selectOnCanvas = true) {
    if (!edgeByUiId(id)) return;
    activeEditorEdgeId = String(id);
    refreshEditorPanel(activeEditorNodeId, activeEditorEdgeId);
    if (selectOnCanvas && network) network.selectEdges([edgeByUiId(id).id]);
}

window.selectNodeForEditing = function(id) { if (id !== '') setEditorNodeSelection(id, true); };
window.selectEdgeForEditing = function(id) { if (id !== '') setEditorEdgeSelection(id, true); };

function syncGraphToOutput() {
    if (!nodesDataset || !edgesDataset) return;
    const nodes = nodesDataset.get().filter(node => node.shape !== 'square');
    const edges = edgesDataset.get();
    const incident = new Set();
    const lines = [];
    edges.forEach(edge => {
        const from = String(edge.from), to = String(edge.to);
        incident.add(from); incident.add(to);
        lines.push(edge.label !== undefined && String(edge.label).trim() !== ''
            ? `${from} ${to} ${String(edge.label).trim()}`
            : `${from} ${to}`);
    });
    nodes.forEach(node => { if (!incident.has(String(node.id))) lines.push(String(node.id)); });
    setOutputProgrammatically(lines.join('\n'));
    syncGraphControls(new Set(nodes.map(node => String(node.id))), edges, true);
    if (network) network.setOptions({ edges: { arrows: { to: { enabled: document.getElementById('isDirected').value === 'true' } } } });
}

function renameNodeId(oldId, newId) {
    const oldNode = nodeById(oldId);
    if (!oldNode) return false;
    if (!newId || /\s/.test(newId)) { alert('节点名称不能为空，也不能包含空格。'); return false; }
    if (newId !== String(oldId) && nodeById(newId)) { alert(`节点「${newId}」已经存在。`); return false; }
    if (newId === String(oldId)) {
        nodesDataset.update({ id: oldNode.id, label: newId });
        return true;
    }
    const position = network ? network.getPositions([oldNode.id])[oldNode.id] : null;
    const replacement = Object.assign({}, oldNode, { id: newId, label: newId });
    if (position) { replacement.x = position.x; replacement.y = position.y; }
    nodesDataset.remove(oldNode.id);
    nodesDataset.add(replacement);
    edgesDataset.update(edgesDataset.get().map(edge => {
        const update = { id: edge.id };
        if (String(edge.from) === String(oldId)) update.from = newId;
        if (String(edge.to) === String(oldId)) update.to = newId;
        return update;
    }));
    activeEditorNodeId = newId;
    return true;
}

window.saveEditorNode = function() {
    if (isBCTreeMode) return;
    const oldId = activeEditorNodeId;
    const node = nodeById(oldId);
    if (!node) { alert('请先选择一个节点。'); return; }
    const newName = document.getElementById('editNodeName').value.trim();
    const color = document.getElementById('editNodeColor').value || '#000000';
    if (!renameNodeId(String(oldId), newName)) return;
    const updatedId = newName;
    updateNodeStyle(updatedId, { label: updatedId, customColor: color });
    activeEditorNodeId = updatedId;
    syncGraphToOutput();
    refreshEditorPanel(updatedId, activeEditorEdgeId);
    updateLayoutButtonsVisibility();
};

window.saveEditorEdge = function() {
    if (isBCTreeMode) return;
    const edge = edgeByUiId(activeEditorEdgeId);
    if (!edge) { alert('请先选择一条边。'); return; }
    const label = document.getElementById('editEdgeLabel').value.trim();
    const replacement = Object.assign({}, edge);
    if (label === '') delete replacement.label;
    else replacement.label = label;
    edgesDataset.remove(edge.id);
    edgesDataset.add(replacement);
    activeEditorEdgeId = String(edge.id);
    syncGraphToOutput();
    refreshEditorPanel(activeEditorNodeId, String(edge.id));
};


function ensureEditorPanelOpen() {
    const panel = document.getElementById('editorPanel');
    if (!panel || !panel.classList.contains('collapsed')) return;
    panel.classList.remove('collapsed');
    const toggle = document.getElementById('editorToggle');
    if (toggle) {
        toggle.textContent = '›';
        toggle.setAttribute('aria-label', '折叠编辑栏');
    }
    setTimeout(() => { if (network) network.redraw(); }, 220);
}

window.setInteractionMode = function(mode) {
    if (isBCTreeMode) return;
    if (!['normal', 'add', 'edit', 'delete'].includes(mode)) return;
    if (mode !== 'normal' && interactionMode === mode) mode = 'normal';
    interactionMode = mode;
    pendingAddEdgeFrom = null;

    const buttons = { add: 'modeAddBtn', edit: 'modeEditBtn', delete: 'modeDeleteBtn' };
    Object.entries(buttons).forEach(([name, id]) => {
        const button = document.getElementById(id);
        if (!button) return;
        button.classList.toggle('active', mode === name);
        button.setAttribute('aria-pressed', String(mode === name));
    });
    const canvas = document.getElementById('mynetwork');
    if (canvas) {
        canvas.classList.toggle('mode-add', mode === 'add');
        canvas.classList.toggle('mode-edit', mode === 'edit');
        canvas.classList.toggle('mode-delete', mode === 'delete');
    }
    if (mode !== 'normal') ensureEditorPanelOpen();
    const hint = document.getElementById('editorHint');
    if (mode === 'add') hint.textContent = '添加模式：单击空白处创建节点；依次单击两个节点创建一条无权边。再次点击“添加模式”退出。';
    else if (mode === 'edit') hint.textContent = '编辑模式：单击节点或边后编辑右侧属性；双击边可直接编辑边权。再次点击“编辑模式”退出。';
    else if (mode === 'delete') hint.textContent = '删除模式：单击节点将删除该节点及关联边；单击边删除该边。再次点击“删除模式”退出。';
    else hint.textContent = '普通模式：单击节点固定/解除固定，拖动不会切换固定状态；双击节点改名，双击边编辑边权。';
    refreshEditorPanel(activeEditorNodeId, activeEditorEdgeId);
};

function firstMissingNumericNodeId() {
    const used = new Set(nodesDataset.getIds().map(id => String(id)));
    let id = 1;
    while (used.has(String(id))) id++;
    return String(id);
}

function addNodeAtCanvasPoint(point) {
    if (isBCTreeMode || !nodesDataset) return null;
    const id = firstMissingNumericNodeId();
    const node = getStyleObject({ id, label: id, customColor: '#000000' }, { id, customColor: '#000000', isPinned: true });
    node.x = point.x;
    node.y = point.y;
    nodesDataset.add(node);
    activeEditorNodeId = id;
    syncGraphToOutput();
    refreshEditorPanel(id, activeEditorEdgeId);
    updateLayoutButtonsVisibility();
    if (network) {
        network.selectNodes([id]);
        network.redraw();
    }
    return id;
}

function createEdgeBetween(from, to, label = '') {
    if (isBCTreeMode || !edgesDataset) return null;
    from = String(from);
    to = String(to);
    if (!nodeById(from) || !nodeById(to)) return null;
    if (from === to) {
        alert('暂不支持连接节点自身。');
        return null;
    }
    const directed = document.getElementById('isDirected').value === 'true';
    const duplicate = edgesDataset.get().some(edge => directed
        ? String(edge.from) === from && String(edge.to) === to
        : ((String(edge.from) === from && String(edge.to) === to) || (String(edge.from) === to && String(edge.to) === from)));
    if (duplicate) {
        alert('这条边已经存在。');
        return null;
    }
    const data = { from, to };
    const trimmedLabel = String(label || '').trim();
    if (trimmedLabel !== '') data.label = trimmedLabel;
    const added = edgesDataset.add(data);
    const edgeId = Array.isArray(added) ? added[0] : added;
    activeEditorEdgeId = String(edgeId);
    syncGraphToOutput();
    refreshEditorPanel(activeEditorNodeId, String(edgeId));
    if (network) {
        network.selectEdges([edgeId]);
        window.forcePhysicsUpdate();
    }
    updateLayoutButtonsVisibility();
    return edgeId;
}

window.addNode = function() {
    if (isBCTreeMode) return;
    const name = document.getElementById('newNodeName').value.trim();
    if (!name || /\s/.test(name)) { alert('节点名称不能为空，也不能包含空格。'); return; }
    if (nodeById(name)) { alert(`节点「${name}」已经存在。`); return; }
    const node = getStyleObject({ id: name, label: name, customColor: '#000000' }, { id: name, customColor: '#000000', isPinned: false });
    const center = network ? network.getViewPosition() : { x: 0, y: 0 };
    node.x = center.x + (Math.random() - 0.5) * 80;
    node.y = center.y + (Math.random() - 0.5) * 80;
    nodesDataset.add(node);
    document.getElementById('newNodeName').value = '';
    activeEditorNodeId = name;
    syncGraphToOutput();
    refreshEditorPanel(name, activeEditorEdgeId);
    if (network) { network.selectNodes([name]); window.forcePhysicsUpdate(); }
    updateLayoutButtonsVisibility();
};

window.addEdge = function() {
    if (isBCTreeMode) return;
    const from = document.getElementById('newEdgeFrom').value;
    const to = document.getElementById('newEdgeTo').value;
    const label = document.getElementById('newEdgeLabel').value.trim();
    if (!nodeById(from) || !nodeById(to)) { alert('请先建立至少两个节点，并选择起点和终点。'); return; }
    const edgeId = createEdgeBetween(from, to, label);
    if (edgeId !== null) document.getElementById('newEdgeLabel').value = '';
};

window.deleteSelectedNode = function() {
    if (isBCTreeMode) return;
    const node = nodeById(activeEditorNodeId);
    if (!node) { alert('请先选择一个节点。'); return; }
    const id = String(node.id);
    if (pendingAddEdgeFrom === id) pendingAddEdgeFrom = null;
    edgesDataset.remove(edgesDataset.get().filter(edge => String(edge.from) === id || String(edge.to) === id).map(edge => edge.id));
    nodesDataset.remove(node.id);
    activeEditorNodeId = null;
    if (network) network.unselectAll();
    syncGraphToOutput();
    refreshEditorPanel(null, activeEditorEdgeId);
    updateLayoutButtonsVisibility();
    window.forcePhysicsUpdate();
};

window.deleteSelectedEdge = function() {
    if (isBCTreeMode) return;
    const edge = edgeByUiId(activeEditorEdgeId);
    if (!edge) { alert('请先选择一条边。'); return; }
    edgesDataset.remove(edge.id);
    activeEditorEdgeId = null;
    if (network) network.unselectAll();
    syncGraphToOutput();
    refreshEditorPanel(activeEditorNodeId, null);
    updateLayoutButtonsVisibility();
    window.forcePhysicsUpdate();
};

function openInlineNodeEditor(id) {
    if (!network || isBCTreeMode) return;
    const node = nodeById(id);
    if (!node) return;
    const container = document.getElementById('mynetwork');
    const old = document.getElementById('inlineNodeEditor');
    if (old) old.remove();
    const position = network.getPositions([node.id])[node.id];
    if (!position) return;
    const point = network.canvasToDOM(position);
    const input = document.createElement('input');
    input.type = 'text';
    input.id = 'inlineNodeEditor';
    input.className = 'inline-node-editor';
    input.value = String(node.label || node.id);
    input.dataset.nodeId = String(node.id);
    input.style.left = `${point.x}px`;
    input.style.top = `${point.y}px`;
    container.appendChild(input);
    let finished = false;
    const finish = commit => {
        if (finished) return;
        finished = true;
        const oldNodeId = input.dataset.nodeId;
        const name = input.value.trim();
        input.remove();
        if (commit && renameNodeId(oldNodeId, name)) {
            activeEditorNodeId = name;
            syncGraphToOutput();
            refreshEditorPanel(name, activeEditorEdgeId);
            updateLayoutButtonsVisibility();
        }
    };
    input.addEventListener('keydown', event => {
        if (event.key === 'Enter') { event.preventDefault(); finish(true); }
        else if (event.key === 'Escape') { event.preventDefault(); finish(false); }
    });
    input.addEventListener('blur', () => finish(true));
    input.focus();
    input.select();
}

window.toggleEditorPanel = function() {
    const panel = document.getElementById('editorPanel');
    panel.classList.toggle('collapsed');
    const collapsed = panel.classList.contains('collapsed');
    document.getElementById('editorToggle').textContent = collapsed ? '‹' : '›';
    document.getElementById('editorToggle').setAttribute('aria-label', collapsed ? '展开编辑栏' : '折叠编辑栏');
    setTimeout(() => { if (network) network.redraw(); }, 220);
};
function updateMHint() {
    const hint = document.getElementById('mHint');
    if (!hint) return;
    const n = Math.max(0, parseInt(document.getElementById('n').value) || 0);
    const m = parseInt(document.getElementById('m').value);
    const structure = document.getElementById('graphStructure').value;
    const directed = document.getElementById('isDirected').value === 'true';
    let message = '';

    if (Number.isNaN(m) || m < 0 || ['tree', 'chain', 'daisy', 'binary'].includes(structure)) {
        hint.textContent = '';
        hint.classList.remove('warning');
        return;
    }
    const undirectedMax = n * Math.max(0, n - 1) / 2;
    if (structure === 'cactus') {
        const min = n > 1 ? n - 1 : 0;
        const max = n > 0 ? n - 1 + Math.floor((n - 1) / 2) : 0;
        if (m < min || m > max) message = `仙人掌需保持连通，M 应在 ${min} 到 ${max} 之间；生成时会调整到合法范围。`;
    } else if (structure === 'bipartite') {
        const max = Math.floor(n * n / 4) * (directed ? 2 : 1);
        if (m > max) message = `当前二分图最多可构造 ${max} 条${directed ? '有向' : '无向'}边；生成时会限制到上限。`;
        else if (n >= 2 && m >= undirectedMax) message = `边数已达到无向完全图的边数规模（${Math.floor(undirectedMax)}）。`;
    } else {
        const max = directed ? n * Math.max(0, n - 1) : undirectedMax;
        if (m > max) message = `超过当前${directed ? '有向' : '无向'}简单图上限 ${max}，生成时会限制到上限。`;
        else if (n >= 2 && m >= undirectedMax) message = directed
            ? `已达到无向完全图边数规模（${Math.floor(undirectedMax)}）；有向图上限为 ${max}。`
            : `已达到无向完全图的边数上限（${Math.floor(undirectedMax)}）。`;
    }
    hint.textContent = message;
    hint.classList.toggle('warning', Boolean(message));
}

window.updateInputs = function() {
    const nInput = document.getElementById('n');
    const mInput = document.getElementById('m');
    const maxwInput = document.getElementById('maxw');
    const struct = document.getElementById('graphStructure').value;
    const isDirSelect = document.getElementById('isDirected');
    const isWSelect = document.getElementById('isWeighted');
    const n = Math.max(0, parseInt(nInput.value) || 0);

    if (['tree', 'chain', 'daisy', 'binary'].includes(struct)) {
        isDirSelect.value = 'false';
        isDirSelect.disabled = true;
        mInput.disabled = true;
        mInput.min = 0;
        mInput.max = Math.max(0, n - 1);
        mInput.value = Math.max(0, n - 1);
    } else if (struct === 'cactus') {
        isDirSelect.value = 'false';
        isDirSelect.disabled = true;
        mInput.disabled = false;
        mInput.min = n > 0 ? Math.max(0, n - 1) : 0;
        mInput.max = n > 0 ? n - 1 + Math.floor((n - 1) / 2) : 0;
    } else {
        isDirSelect.disabled = false;
        mInput.disabled = false;
        mInput.min = 0;
        mInput.max = isDirSelect.value === 'true' ? n * Math.max(0, n - 1) : Math.min(10000, n * Math.max(0, n - 1) / 2);
    }
    maxwInput.disabled = isWSelect.value === 'false';
    updateMHint();
    renderGraphFromText(false, false);
}

window.generateData = function() {
    let n = parseInt(document.getElementById('n').value), m = parseInt(document.getElementById('m').value), maxw = parseInt(document.getElementById('maxw').value);
    const struct = document.getElementById('graphStructure').value;
    const isDirected = document.getElementById('isDirected').value === 'true';
    const isWeighted = document.getElementById('isWeighted').value === 'true';
    if (Number.isNaN(n) || n < 1) n = 10;
    if (n > 300) { alert('节点数暂时限制在 300 以内。'); n = 300; document.getElementById('n').value = 300; }
    if (Number.isNaN(m) || m < 0) m = Math.max(0, n - 1);
    if (Number.isNaN(maxw) || maxw < 1) maxw = 10;
    updateMHint();

    let edges = [];
    switch (struct) {
        case 'tree': edges = getEdges_Tree(n); break;
        case 'chain': edges = getEdges_Chain(n); break;
        case 'daisy': edges = getEdges_Daisy(n); break;
        case 'binary': edges = getEdges_Binary(n); break;
        case 'cactus': edges = getEdges_Cactus(n, m); break;
        case 'bipartite': edges = getEdges_Bipartite(n, m, isDirected); break;
        case 'graph': edges = getEdges_Graph(n, m, isDirected); break;
    }
    if (isWeighted) edges = edges.map(edge => [edge[0], edge[1], rand(1, maxw)]);
    let output = '';
    const generatedNodes = new Set();
    for (const edge of edges) {
        output += edge.join(' ') + '\n';
        generatedNodes.add(String(edge[0]));
        generatedNodes.add(String(edge[1]));
    }
    for (let i = 1; i <= n; i++) if (!generatedNodes.has(String(i))) output += i + '\n';
    setOutputProgrammatically(output.trim());
    renderGraphFromText(false, false);
    updateMHint();
}

window.zoomGraph = function(action) {
    if (!network) return;
    if (action === 'home') {
        network.fit({ animation: { duration: 350 } });
        return;
    }
    const factor = Number(action);
    if (!Number.isFinite(factor) || factor <= 0) return;
    const targetScale = Math.max(MIN_GRAPH_SCALE, Math.min(MAX_GRAPH_SCALE, network.getScale() * factor));
    network.moveTo({ position: network.getViewPosition(), scale: targetScale, animation: { duration: 120 } });
};

window.copyOutput = function() { navigator.clipboard.writeText(document.getElementById('output').value).then(() => { const fb = document.getElementById('copyFeedback'); fb.textContent = '已复制！'; fb.style.opacity = 1; setTimeout(() => fb.style.opacity = 0, 2000); }); }

// ====== 新增：导出图片逻辑（已修复透明背景变黑的问题） ======
window.exportImage = function(format) {
    if (!network) return;
    
    const container = document.getElementById('mynetwork');
    const canvas = container.getElementsByTagName('canvas')[0];
    if (!canvas) {
        alert("无法获取画布内容，请稍后重试！");
        return;
    }

    // 创建一个临时画布
    const tempCanvas = document.createElement('canvas');
    tempCanvas.width = canvas.width;
    tempCanvas.height = canvas.height;
    const ctx = tempCanvas.getContext('2d');
    
    // 使用当前主题的画布底色，导出图与编辑器所见主题保持一致
    ctx.fillStyle = THEME_COLORS[currentTheme].canvasBg;
    ctx.fillRect(0, 0, tempCanvas.width, tempCanvas.height);
    
    // 将 vis-network 的原始画布绘制在主题底色之上
    ctx.drawImage(canvas, 0, 0);

    // 转换为对应格式的 Base64 数据
    let dataURL;
    if (format === 'jpeg') {
        dataURL = tempCanvas.toDataURL('image/jpeg', 1.0);
    } else {
        dataURL = tempCanvas.toDataURL('image/png');
    }

    // 触发下载
    const a = document.createElement('a');
    a.href = dataURL;
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    a.download = `Graph_${timestamp}.${format === 'jpeg' ? 'jpg' : 'png'}`;
    
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
}
// ========================================================



document.addEventListener('visibilitychange', () => {
    if (!network) return;
    if (document.hidden) {
        physicsPausedForVisibility = true;
        network.stopSimulation();
        network.setOptions({ physics: { enabled: false } });
        return;
    }
    network.redraw();
    if (nodesDataset && nodesDataset.get().some(node => !node.isPinned && node.shape !== 'square') && !isBCTreeMode) {
        window.forcePhysicsUpdate();
    } else {
        network.stopSimulation();
        network.setOptions({ physics: { enabled: false } });
    }
    physicsPausedForVisibility = false;
});

window.addEventListener('pageshow', () => {
    if (!network) return;
    network.redraw();
    if (!document.hidden && nodesDataset && nodesDataset.get().some(node => !node.isPinned && node.shape !== 'square') && !isBCTreeMode) {
        window.forcePhysicsUpdate();
    }
});

document.addEventListener('DOMContentLoaded', () => {
    try {
        if (typeof vis === 'undefined') { alert('网络库加载失败，请检查网络或更换 CDN。'); return; }
        initNetwork();
        initOutputHistory();
		applyTheme(currentTheme);
        ['graphStructure', 'isDirected', 'isWeighted'].forEach(id => { const el = document.getElementById(id); if(el) el.addEventListener('change', () => { updateInputs(); generateData(); }); });
        const elN = document.getElementById('n'); if(elN) { elN.addEventListener('input', updateMHint); elN.addEventListener('change', updateInputs); }
        const elM = document.getElementById('m'); if(elM) { elM.addEventListener('input', updateMHint); elM.addEventListener('change', () => { updateMHint(); generateData(); }); }
        const elDir = document.getElementById('isDirected'); if (elDir) elDir.addEventListener('change', updateMHint);
        const elStruct = document.getElementById('graphStructure'); if (elStruct) elStruct.addEventListener('change', updateMHint);
        updateInputs(); generateData();
        window.setInteractionMode('normal');
        const colorInput = document.getElementById('editNodeColor');
        if (colorInput) colorInput.addEventListener('input', () => { document.getElementById('editNodeColorText').textContent = colorInput.value.toUpperCase(); });
        refreshEditorPanel();
    } catch (error) { console.error(error); alert("初始化失败: " + error.message); }
});
