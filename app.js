'use strict';

(() => {
  const DIRECTIONS = ['North', 'East', 'South', 'West'];
  const DELTAS = [[0, -1], [1, 0], [0, 1], [-1, 0]];
  const els = Object.fromEntries([
    'tileWidth', 'tileHeight', 'tileFiles', 'sheetFile', 'tilesList', 'tileCount', 'clearTiles',
    'sheetOptions', 'sheetName', 'sliceWidth', 'sliceHeight', 'slicePreview', 'sheetNameInput', 'sliceSheet', 'edgeMatching', 'ruleTile',
    'ruleDirection', 'toggleAllRules', 'neighborRules', 'gridColumns', 'gridRows', 'allowRotations',
    'selectedTileName', 'rotateLeft', 'rotateRight', 'rotationValue', 'generate', 'clearGrid',
    'exportPng', 'gridDimensions', 'boardStatus', 'board', 'boardEmpty', 'boardViewport'
  ].map(id => [id, document.getElementById(id)]));

  const ctx = els.board.getContext('2d');
  const tiles = [];
  const pins = new Map();
  let selectedTileId = null;
  let selectedRotation = 0;
  let sheetImage = null;
  let sheetFileName = '';
  let variants = [];
  let lastSolution = null;
  let solved = false;
  let isGenerating = false;

  const tileById = id => tiles.find(tile => tile.id === id);
  const cellSize = () => ({
    width: numberValue(els.tileWidth, 32, 1, 256),
    height: numberValue(els.tileHeight, 32, 1, 256)
  });
  const gridSize = () => ({
    columns: numberValue(els.gridColumns, 12, 1, 60),
    rows: numberValue(els.gridRows, 10, 1, 60)
  });
  let previousGridSize = gridSize();

  function numberValue(input, fallback, min, max) {
    const value = Math.floor(Number(input.value));
    return Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback;
  }

  function createCanvas(width, height) {
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    return canvas;
  }

  function createTile(name, source) {
    const { width, height } = cellSize();
    const canvas = createCanvas(width, height);
    const tileCtx = canvas.getContext('2d');
    tileCtx.imageSmoothingEnabled = false;
    tileCtx.drawImage(source, 0, 0, width, height);
    const tile = {
      id: crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`,
      name: name.trim() || `Tile ${tiles.length + 1}`,
      canvas,
      enabled: true,
      rules: Array.from({ length: 4 }, () => new Set())
    };
    for (const other of tiles) {
      for (const rules of tile.rules) rules.add(other.id);
      for (const rules of other.rules) rules.add(tile.id);
    }
    for (const rules of tile.rules) rules.add(tile.id);
    tiles.push(tile);
    return tile;
  }

  function loadImage(file) {
    return new Promise((resolve, reject) => {
      const image = new Image();
      const url = URL.createObjectURL(file);
      image.onload = () => {
        URL.revokeObjectURL(url);
        resolve(image);
      };
      image.onerror = () => {
        URL.revokeObjectURL(url);
        reject(new Error(`Could not read image “${file.name}”.`));
      };
      image.src = url;
    });
  }

  function showStatus(message, isError = false) {
    els.boardStatus.textContent = message;
    els.boardStatus.style.color = isError ? '#b75e42' : '';
  }

  function invalidatePattern(message = 'Ready when you are') {
    solved = false;
    lastSolution = null;
    variants = [];
    els.exportPng.disabled = true;
    showStatus(message);
    drawGrid();
  }

  function renderAll() {
    renderTiles();
    renderRuleEditor();
    updateControls();
    drawGrid();
  }

  function renderTiles() {
    els.tilesList.replaceChildren();
    els.tilesList.classList.toggle('empty-list', tiles.length === 0);
    if (tiles.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'empty-tiles';
      empty.innerHTML = '<span>▧</span><p>Your tile tray is empty.<br>Add some image tiles to begin.</p>';
      els.tilesList.append(empty);
    } else {
      for (const tile of tiles) {
        const entry = document.createElement('div');
        entry.className = 'tile-entry';
        const button = document.createElement('button');
        button.type = 'button';
        button.className = `tile-card${tile.id === selectedTileId ? ' selected' : ''}${tile.enabled ? '' : ' excluded'}`;
        button.title = `${tile.name} — click to select for placement`;
        button.disabled = !tile.enabled;
        button.setAttribute('aria-pressed', String(tile.id === selectedTileId));
        const thumb = createCanvas(64, 64);
        const thumbCtx = thumb.getContext('2d');
        thumbCtx.imageSmoothingEnabled = false;
        thumbCtx.drawImage(tile.canvas, 0, 0, 64, 64);
        const name = document.createElement('span');
        name.className = 'tile-name';
        name.textContent = tile.name;
        button.append(thumb, name);
        button.addEventListener('click', () => {
          selectedTileId = tile.id;
          selectedRotation = 0;
          renderAll();
        });
        const useLabel = document.createElement('label');
        useLabel.className = 'tile-use-toggle';
        useLabel.title = tile.enabled ? 'Include in generation' : 'Exclude from generation';
        const useCheckbox = document.createElement('input');
        useCheckbox.type = 'checkbox';
        useCheckbox.checked = tile.enabled;
        useCheckbox.setAttribute('aria-label', `Use ${tile.name} in generation`);
        useCheckbox.addEventListener('click', event => event.stopPropagation());
        useCheckbox.addEventListener('change', () => {
          const pinned = [...pins.values()].some(pin => pin.tileId === tile.id);
          if (!useCheckbox.checked && pinned) {
            useCheckbox.checked = true;
            showStatus('Remove this tile’s pins before excluding it', true);
            return;
          }
          tile.enabled = useCheckbox.checked;
          if (!tile.enabled && selectedTileId === tile.id) {
            selectedTileId = tiles.find(item => item.enabled)?.id || null;
            selectedRotation = 0;
          }
          invalidatePattern('Tile selection changed — generate again');
          renderAll();
        });
        useLabel.append(useCheckbox);
        entry.append(button, useLabel);
        els.tilesList.append(entry);
      }
    }
    const enabledCount = tiles.filter(tile => tile.enabled).length;
    els.tileCount.textContent = `${enabledCount} of ${tiles.length} used`;
    els.clearTiles.disabled = tiles.length === 0;
    els.generate.disabled = enabledCount === 0 || isGenerating;
  }

  function renderRuleEditor() {
    const oldId = els.ruleTile.value;
    els.ruleTile.replaceChildren();
    if (tiles.length === 0) {
      els.ruleTile.add(new Option('Add tiles first', ''));
      els.ruleTile.disabled = true;
      els.ruleDirection.disabled = true;
      els.toggleAllRules.disabled = true;
      els.neighborRules.innerHTML = '<p class="muted">Add tiles to edit connections.</p>';
      return;
    }
    for (const tile of tiles) els.ruleTile.add(new Option(tile.name, tile.id));
    els.ruleTile.disabled = false;
    els.ruleTile.value = tileById(oldId) ? oldId : (selectedTileId || tiles[0].id);
    els.ruleDirection.disabled = false;
    renderNeighborRules();
  }

  function renderNeighborRules() {
    const tile = tileById(els.ruleTile.value);
    const direction = Number(els.ruleDirection.value);
    if (!tile) return;
    els.neighborRules.replaceChildren();
    for (const neighbor of tiles) {
      const label = document.createElement('label');
      label.className = 'neighbor-option';
      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.checked = tile.rules[direction].has(neighbor.id);
      checkbox.addEventListener('change', () => {
        if (checkbox.checked) tile.rules[direction].add(neighbor.id);
        else tile.rules[direction].delete(neighbor.id);
        invalidatePattern('Rules changed — generate again');
      });
      const text = document.createElement('span');
      text.textContent = neighbor.name;
      label.append(checkbox, text);
      els.neighborRules.append(label);
    }
    const anyAllowed = tile.rules[direction].size > 0;
    els.toggleAllRules.textContent = anyAllowed ? 'None' : 'All';
    els.toggleAllRules.disabled = tiles.length === 0;
  }

  function updateControls() {
    const selected = tileById(selectedTileId);
    els.selectedTileName.textContent = selected ? selected.name : 'None';
    els.rotationValue.textContent = `${selectedRotation}°`;
    els.rotateLeft.disabled = !selected || !els.allowRotations.checked;
    els.rotateRight.disabled = !selected || !els.allowRotations.checked;
    els.clearGrid.disabled = pins.size === 0;
    els.gridDimensions.textContent = `${gridSize().columns} × ${gridSize().rows} grid`;
    els.boardEmpty.hidden = tiles.length > 0 && (solved || pins.size > 0);
  }

  function getOrientedCanvas(tile, rotation) {
    const { width, height } = cellSize();
    const canvas = createCanvas(width, height);
    const orientedCtx = canvas.getContext('2d');
    orientedCtx.imageSmoothingEnabled = false;
    orientedCtx.translate(width / 2, height / 2);
    orientedCtx.rotate(rotation * Math.PI / 180);
    if (rotation === 90 || rotation === 270) {
      orientedCtx.drawImage(tile.canvas, -height / 2, -width / 2, height, width);
    } else {
      orientedCtx.drawImage(tile.canvas, -width / 2, -height / 2, width, height);
    }
    return canvas;
  }

  function buildVariants() {
    const rotations = els.allowRotations.checked ? [0, 90, 180, 270] : [0];
    variants = [];
    for (const tile of tiles) {
      if (!tile.enabled) continue;
      for (const rotation of rotations) {
        const canvas = rotation === 0 ? tile.canvas : getOrientedCanvas(tile, rotation);
        variants.push({
          tileId: tile.id,
          rotation,
          rotationSteps: rotation / 90,
          canvas,
          edges: getEdges(canvas)
        });
      }
    }
  }

  function getEdges(canvas) {
    const imageData = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height);
    const { width, height, data } = imageData;
    const edges = [[], [], [], []];
    for (let x = 0; x < width; x++) {
      edges[0].push(pixelAt(data, width, x, 0));
      edges[2].push(pixelAt(data, width, x, height - 1));
    }
    for (let y = 0; y < height; y++) {
      edges[1].push(pixelAt(data, width, width - 1, y));
      edges[3].push(pixelAt(data, width, 0, y));
    }
    return edges;
  }

  function pixelAt(data, width, x, y) {
    const index = (y * width + x) * 4;
    return `${data[index]},${data[index + 1]},${data[index + 2]},${data[index + 3]}`;
  }

  function edgesMatch(first, second, direction) {
    const opposite = (direction + 2) % 4;
    const edgeA = first.edges[direction];
    const edgeB = second.edges[opposite];
    if (edgeA.length !== edgeB.length) return false;
    return edgeA.every((pixel, index) => pixel === edgeB[index]);
  }

  function manuallyCompatible(first, second, direction) {
    const firstTile = tileById(first.tileId);
    const secondTile = tileById(second.tileId);
    const firstSide = (direction - first.rotationSteps + 4) % 4;
    const secondSide = (direction + 2 - second.rotationSteps + 4) % 4;
    return firstTile.rules[firstSide].has(second.tileId) &&
      secondTile.rules[secondSide].has(first.tileId);
  }

  function compatible(first, second, direction) {
    return manuallyCompatible(first, second, direction) &&
      (!els.edgeMatching.checked || edgesMatch(first, second, direction));
  }

  function drawGrid(solution = null) {
    const { columns, rows } = gridSize();
    const { width, height } = cellSize();
    els.board.width = columns * width;
    els.board.height = rows * height;
    ctx.clearRect(0, 0, els.board.width, els.board.height);
    ctx.fillStyle = '#f7f7f2';
    ctx.fillRect(0, 0, els.board.width, els.board.height);

    if (solution) {
      solution.forEach((variantIndex, cell) => {
        if (variantIndex === null || variantIndex === undefined) return;
        const x = (cell % columns) * width;
        const y = Math.floor(cell / columns) * height;
        ctx.drawImage(variants[variantIndex].canvas, x, y);
      });
    }

    for (const [cell, pin] of pins) {
      const tile = tileById(pin.tileId);
      if (!tile) continue;
      const canvas = pin.rotation === 0 ? tile.canvas : getOrientedCanvas(tile, pin.rotation);
      ctx.drawImage(canvas, (cell % columns) * width, Math.floor(cell / columns) * height);
      ctx.fillStyle = '#de8558';
      ctx.beginPath();
      ctx.arc((cell % columns) * width + 5, Math.floor(cell / columns) * height + 5, 2.5, 0, Math.PI * 2);
      ctx.fill();
    }

    ctx.strokeStyle = '#dadbd2';
    ctx.lineWidth = Math.max(1, Math.min(width, height) / 32);
    for (let x = 0; x <= columns; x++) {
      ctx.beginPath();
      ctx.moveTo(x * width + 0.5, 0);
      ctx.lineTo(x * width + 0.5, rows * height);
      ctx.stroke();
    }
    for (let y = 0; y <= rows; y++) {
      ctx.beginPath();
      ctx.moveTo(0, y * height + 0.5);
      ctx.lineTo(columns * width, y * height + 0.5);
      ctx.stroke();
    }
    updateControls();
  }

  function cellAtPointer(event) {
    const rect = els.board.getBoundingClientRect();
    const { columns, rows } = gridSize();
    const x = Math.floor(((event.clientX - rect.left) / rect.width) * els.board.width);
    const y = Math.floor(((event.clientY - rect.top) / rect.height) * els.board.height);
    const { width, height } = cellSize();
    const col = Math.floor(x / width);
    const row = Math.floor(y / height);
    if (col < 0 || row < 0 || col >= columns || row >= rows) return null;
    return row * columns + col;
  }

  function neighborsOf(cell, columns, rows) {
    const x = cell % columns;
    const y = Math.floor(cell / columns);
    const result = [];
    for (let direction = 0; direction < 4; direction++) {
      const nx = x + DELTAS[direction][0];
      const ny = y + DELTAS[direction][1];
      if (nx >= 0 && ny >= 0 && nx < columns && ny < rows) {
        result.push({ cell: ny * columns + nx, direction });
      }
    }
    return result;
  }

  function propagate(domains, startingCells, columns, rows) {
    const queue = [...startingCells];
    let cursor = 0;
    while (cursor < queue.length) {
      const cell = queue[cursor++];
      const sourceDomain = domains[cell];
      if (sourceDomain.size === 0) return false;
      for (const { cell: neighbor, direction } of neighborsOf(cell, columns, rows)) {
        const neighborDomain = domains[neighbor];
        let changed = false;
        for (const candidate of neighborDomain) {
          let supported = false;
          for (const sourceIndex of sourceDomain) {
            if (compatible(variants[sourceIndex], variants[candidate], direction)) {
              supported = true;
              break;
            }
          }
          if (!supported) {
            neighborDomain.delete(candidate);
            changed = true;
          }
        }
        if (neighborDomain.size === 0) return false;
        if (changed) queue.push(neighbor);
      }
    }
    return true;
  }

  function makeInitialDomains(cellCount, columns, rows) {
    const domains = Array.from({ length: cellCount }, () => new Set(variants.map((_, index) => index)));
    const pinnedCells = [];
    for (const [cell, pin] of pins) {
      const matching = variants.findIndex(variant =>
        variant.tileId === pin.tileId && variant.rotation === pin.rotation
      );
      if (matching === -1) return null;
      domains[cell] = new Set([matching]);
      pinnedCells.push(cell);
    }
    if (pinnedCells.length > 0 && !propagate(domains, pinnedCells, columns, rows)) return null;
    return domains;
  }

  function solveAttempt(columns, rows) {
    const cellCount = columns * rows;
    const domains = makeInitialDomains(cellCount, columns, rows);
    if (!domains) return null;

    while (true) {
      let minSize = Infinity;
      let choices = [];
      for (let cell = 0; cell < cellCount; cell++) {
        const size = domains[cell].size;
        if (size > 1 && size < minSize) {
          minSize = size;
          choices = [cell];
        } else if (size > 1 && size === minSize) {
          choices.push(cell);
        }
      }
      if (choices.length === 0) return domains.map(domain => domain.values().next().value);
      const cell = choices[Math.floor(Math.random() * choices.length)];
      const candidates = [...domains[cell]];
      domains[cell] = new Set([candidates[Math.floor(Math.random() * candidates.length)]]);
      if (!propagate(domains, [cell], columns, rows)) return null;
    }
  }

  function generate() {
    if (tiles.length === 0 || isGenerating) return;
    isGenerating = true;
    renderTiles();
    showStatus('Finding a pattern…');
    buildVariants();

    const { columns, rows } = gridSize();
    const maxAttempts = 40;
    let solution = null;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      solution = solveAttempt(columns, rows);
      if (solution) break;
    }

    isGenerating = false;
    renderTiles();
    if (!solution) {
      invalidatePattern('No solution found — check rules or move a pin', true);
      return;
    }
    solved = true;
    lastSolution = solution;
    els.exportPng.disabled = false;
    showStatus('Pattern complete');
    drawGrid(solution);
  }

  async function addImageFiles(files) {
    const imageFiles = [...files].filter(file => file.type.startsWith('image/'));
    if (imageFiles.length === 0) return;
    const added = [];
    const errors = [];
    for (const file of imageFiles) {
      try {
        const image = await loadImage(file);
        added.push(createTile(file.name.replace(/\.[^.]+$/, ''), image));
      } catch (error) {
        errors.push(error.message);
      }
    }
    if (added.length > 0) {
      selectedTileId = added[added.length - 1].id;
      invalidatePattern(`${added.length} tile${added.length === 1 ? '' : 's'} added`);
    }
    renderAll();
    if (errors.length > 0) showStatus(errors.join(' '), true);
  }

  function addSheetTiles() {
    if (!sheetImage) return;
    const width = numberValue(els.sliceWidth, 32, 1, 256);
    const height = numberValue(els.sliceHeight, 32, 1, 256);
    els.sliceWidth.value = String(width);
    els.sliceHeight.value = String(height);
    els.tileWidth.value = String(width);
    els.tileHeight.value = String(height);
    resizeTiles(width, height);
    const cols = Math.floor(sheetImage.naturalWidth / width);
    const rows = Math.floor(sheetImage.naturalHeight / height);
    if (cols < 1 || rows < 1) {
      showStatus('Tile dimensions are larger than the spritesheet', true);
      return;
    }
    const prefix = els.sheetNameInput.value.trim() || 'sheet';
    const added = [];
    for (let y = 0; y < rows; y++) {
      for (let x = 0; x < cols; x++) {
        const cropped = createCanvas(width, height);
        cropped.getContext('2d').drawImage(sheetImage, x * width, y * height, width, height, 0, 0, width, height);
        added.push(createTile(`${prefix}-${y + 1}-${x + 1}`, cropped));
      }
    }
    if (added.length > 0) {
      selectedTileId = added[0].id;
      invalidatePattern(`${added.length} tiles sliced from spritesheet`);
      renderAll();
    }
  }

  function updateSlicePreview() {
    if (!sheetImage) return;
    const width = numberValue(els.sliceWidth, 32, 1, 256);
    const height = numberValue(els.sliceHeight, 32, 1, 256);
    const columns = Math.floor(sheetImage.naturalWidth / width);
    const rows = Math.floor(sheetImage.naturalHeight / height);
    els.slicePreview.textContent = columns > 0 && rows > 0
      ? `${columns} columns × ${rows} rows · ${columns * rows} tiles`
      : 'Slice size exceeds the spritesheet dimensions.';
  }

  function resizeTiles(width, height) {
    for (const tile of tiles) {
      const resized = createCanvas(width, height);
      resized.getContext('2d').drawImage(tile.canvas, 0, 0, width, height);
      tile.canvas = resized;
    }
  }

  function resetTiles() {
    tiles.splice(0);
    pins.clear();
    selectedTileId = null;
    selectedRotation = 0;
    sheetImage = null;
    invalidatePattern();
    renderAll();
  }

  els.tileFiles.addEventListener('change', async event => {
    await addImageFiles(event.target.files);
    event.target.value = '';
  });
  els.sheetFile.addEventListener('change', async event => {
    const file = event.target.files[0];
    event.target.value = '';
    if (!file) return;
    try {
      sheetImage = await loadImage(file);
      sheetFileName = file.name;
      els.sheetName.textContent = `${sheetFileName} · ${sheetImage.naturalWidth} × ${sheetImage.naturalHeight}`;
      els.sheetNameInput.value = file.name.replace(/\.[^.]+$/, '') || 'sheet';
      els.sliceWidth.value = els.tileWidth.value;
      els.sliceHeight.value = els.tileHeight.value;
      els.sheetOptions.hidden = false;
      updateSlicePreview();
      showStatus('Enter tile dimensions, then slice');
    } catch (error) {
      showStatus(error.message, true);
    }
  });
  els.sliceSheet.addEventListener('click', addSheetTiles);
  for (const input of [els.sliceWidth, els.sliceHeight]) {
    input.addEventListener('input', updateSlicePreview);
    input.addEventListener('change', updateSlicePreview);
  }
  els.clearTiles.addEventListener('click', resetTiles);
  els.ruleTile.addEventListener('change', renderNeighborRules);
  els.ruleDirection.addEventListener('change', renderNeighborRules);
  els.toggleAllRules.addEventListener('click', () => {
    const tile = tileById(els.ruleTile.value);
    if (!tile) return;
    const rules = tile.rules[Number(els.ruleDirection.value)];
    const addAll = rules.size === 0;
    rules.clear();
    if (addAll) for (const neighbor of tiles) rules.add(neighbor.id);
    renderNeighborRules();
    invalidatePattern('Rules changed — generate again');
  });
  els.edgeMatching.addEventListener('change', () => invalidatePattern('Rules changed — generate again'));
  els.allowRotations.addEventListener('change', () => {
    selectedRotation = 0;
    if (!els.allowRotations.checked) {
      for (const [cell, pin] of pins) if (pin.rotation !== 0) pins.set(cell, { ...pin, rotation: 0 });
    }
    invalidatePattern('Tile options changed — generate again');
    updateControls();
  });
  els.rotateLeft.addEventListener('click', () => {
    selectedRotation = (selectedRotation + 270) % 360;
    updateControls();
  });
  els.rotateRight.addEventListener('click', () => {
    selectedRotation = (selectedRotation + 90) % 360;
    updateControls();
  });
  for (const input of [els.tileWidth, els.tileHeight]) {
    input.addEventListener('change', () => {
      const size = cellSize();
      els.tileWidth.value = String(size.width);
      els.tileHeight.value = String(size.height);
      resizeTiles(size.width, size.height);
      invalidatePattern('Tile size changed — generate again');
      renderAll();
    });
  }
  for (const input of [els.gridColumns, els.gridRows]) {
    input.addEventListener('change', () => {
      const { columns, rows } = gridSize();
      const oldColumns = previousGridSize.columns;
      const oldRows = previousGridSize.rows;
      els.gridColumns.value = String(columns);
      els.gridRows.value = String(rows);
      const remappedPins = new Map();
      for (const [cell, pin] of pins) {
        const oldX = cell % oldColumns;
        const oldY = Math.floor(cell / oldColumns);
        if (oldX < columns && oldY < rows) remappedPins.set(oldY * columns + oldX, pin);
      }
      pins.clear();
      for (const [cell, pin] of remappedPins) pins.set(cell, pin);
      previousGridSize = { columns, rows };
      invalidatePattern('Grid size changed — generate again');
      updateControls();
    });
  }
  els.generate.addEventListener('click', generate);
  els.clearGrid.addEventListener('click', () => {
    pins.clear();
    invalidatePattern('Pins cleared');
    updateControls();
  });
  els.board.addEventListener('click', event => {
    const cell = cellAtPointer(event);
    if (cell === null) return;
    if (!selectedTileId) {
      const pin = pins.get(cell);
      if (pin) {
        selectedTileId = pin.tileId;
        selectedRotation = pin.rotation;
        renderAll();
      }
      return;
    }
    pins.set(cell, { tileId: selectedTileId, rotation: selectedRotation });
    invalidatePattern('Tile pinned — generate to fill the rest');
    updateControls();
  });
  els.board.addEventListener('contextmenu', event => {
    event.preventDefault();
    const cell = cellAtPointer(event);
    if (cell !== null && pins.delete(cell)) {
      invalidatePattern('Pin removed — generate to fill the cell');
      updateControls();
    }
  });
  els.exportPng.addEventListener('click', () => {
    if (!solved || !lastSolution) return;
    const { columns, rows } = gridSize();
    const { width, height } = cellSize();
    const exportCanvas = createCanvas(columns * width, rows * height);
    const exportCtx = exportCanvas.getContext('2d');
    exportCtx.fillStyle = '#f7f7f2';
    exportCtx.fillRect(0, 0, exportCanvas.width, exportCanvas.height);
    lastSolution.forEach((variantIndex, cell) => {
      exportCtx.drawImage(variants[variantIndex].canvas, (cell % columns) * width, Math.floor(cell / columns) * height);
    });
    const link = document.createElement('a');
    link.download = 'tilefield-pattern.png';
    link.href = exportCanvas.toDataURL('image/png');
    link.click();
  });

  renderAll();
})();
