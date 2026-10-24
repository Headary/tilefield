'use strict';

(() => {
  const DIRECTIONS = ['North', 'East', 'South', 'West'];
  const DELTAS = [[0, -1], [1, 0], [0, 1], [-1, 0]];
  const els = Object.fromEntries([
    'tileWidth', 'tileHeight', 'tileFiles', 'sheetFile', 'tilesList', 'tileCount', 'clearTiles',
    'sheetOptions', 'sheetName', 'sliceWidth', 'sliceHeight', 'slicePreview', 'sheetNameInput', 'sliceSheet', 'edgeMatching',
    'edgeToleranceControls', 'edgeTolerance', 'edgeToleranceValue', 'cornerTolerance', 'cornerToleranceValue', 'ruleTile',
    'ruleDirection', 'toggleAllRules', 'neighborRules', 'gridColumns', 'gridRows', 'allowRotations',
    'selectedTileName', 'rotateLeft', 'rotateRight', 'rotationValue', 'generate', 'clearGrid',
    'exportPng', 'saveConfig', 'loadConfig', 'configFile', 'gridDimensions', 'boardStatus', 'board', 'boardEmpty', 'boardViewport'
  ].map(id => [id, document.getElementById(id)]));

  const ctx = els.board.getContext('2d');
  const tiles = [];
  const pins = new Map();
  let selectedTileId = null;
  let selectedRotation = 0;
  let sheetImage = null;
  let sheetFileName = '';
  let variants = [];
  let adjacency = [];
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

  function loadImageDataUrl(dataUrl) {
    return new Promise((resolve, reject) => {
      const image = new Image();
      image.onload = () => resolve(image);
      image.onerror = () => reject(new Error('A saved tile image could not be decoded.'));
      image.src = dataUrl;
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
    els.saveConfig.disabled = tiles.length === 0;
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
    els.edgeToleranceControls.hidden = !els.edgeMatching.checked;
    els.edgeToleranceValue.value = `${els.edgeTolerance.value}%`;
    els.cornerToleranceValue.value = `${els.cornerTolerance.value}%`;
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
    adjacency = Array.from({ length: 4 }, (_, direction) =>
      variants.map(first => new Set(
        variants.flatMap((second, index) => compatible(first, second, direction) ? [index] : [])
      ))
    );
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
    return [data[index], data[index + 1], data[index + 2], data[index + 3]];
  }

  function pixelsMatch(first, second, tolerancePercent) {
    const maximumDifference = 255 * tolerancePercent / 100;
    return first.every((channel, index) => Math.abs(channel - second[index]) <= maximumDifference);
  }

  function edgesMatch(first, second, direction) {
    const opposite = (direction + 2) % 4;
    const edgeA = first.edges[direction];
    const edgeB = second.edges[opposite];
    if (edgeA.length !== edgeB.length) return false;
    const lastIndex = edgeA.length - 1;
    return edgeA.every((pixel, index) => {
      const tolerance = index === 0 || index === lastIndex
        ? Number(els.cornerTolerance.value)
        : Number(els.edgeTolerance.value);
      return pixelsMatch(pixel, edgeB[index], tolerance);
    });
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
    const queue = [];
    for (const cell of startingCells) {
      for (const { cell: neighbor, direction } of neighborsOf(cell, columns, rows)) {
        queue.push({ source: cell, target: neighbor, direction });
      }
    }
    let cursor = 0;
    while (cursor < queue.length) {
      const { source, target, direction } = queue[cursor++];
      const sourceDomain = domains[source];
      const targetDomain = domains[target];
      let changed = false;
      for (const candidate of targetDomain) {
        let supported = false;
        const supports = adjacency[direction];
        for (const sourceIndex of sourceDomain) {
          if (supports[sourceIndex].has(candidate)) {
            supported = true;
            break;
          }
        }
        if (!supported) {
          targetDomain.delete(candidate);
          changed = true;
        }
      }
      if (targetDomain.size === 0) return false;
      if (changed) {
        for (const { cell: neighbor, direction: nextDirection } of neighborsOf(target, columns, rows)) {
          if (neighbor !== source) {
            queue.push({ source: target, target: neighbor, direction: nextDirection });
          }
        }
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

  function cloneDomains(domains) {
    return domains.map(domain => new Set(domain));
  }

  function orderCandidates(cell, domains, columns, rows) {
    const scored = [...domains[cell]].map(candidate => {
      let eliminated = 0;
      for (const { cell: neighbor, direction } of neighborsOf(cell, columns, rows)) {
        const allowed = adjacency[direction][candidate];
        for (const neighborCandidate of domains[neighbor]) {
          if (!allowed.has(neighborCandidate)) eliminated++;
        }
      }
      return { candidate, eliminated, tie: Math.random() };
    });
    scored.sort((first, second) =>
      first.eliminated - second.eliminated || first.tie - second.tie
    );
    return scored.map(item => item.candidate);
  }

  function nextBranch(frame, columns, rows) {
    while (frame.nextCandidate < frame.candidates.length) {
      const candidate = frame.candidates[frame.nextCandidate++];
      const branch = cloneDomains(frame.domains);
      branch[frame.cell] = new Set([candidate]);
      if (propagate(branch, [frame.cell], columns, rows)) return branch;
    }
    return null;
  }

  async function solveAttempt(columns, rows) {
    const cellCount = columns * rows;
    const domains = makeInitialDomains(cellCount, columns, rows);
    if (!domains) return null;

    const stack = [];
    let currentDomains = domains;
    let decisions = 0;
    while (true) {
      let minSize = Infinity;
      let choices = [];
      for (let cell = 0; cell < cellCount; cell++) {
        const size = currentDomains[cell].size;
        if (size <= 1) continue;
        const degree = neighborsOf(cell, columns, rows)
          .filter(({ cell: neighbor }) => currentDomains[neighbor].size > 1).length;
        if (size < minSize) {
          minSize = size;
          choices = [{ cell, degree }];
        } else if (size === minSize) {
          choices.push({ cell, degree });
        }
      }
      if (choices.length === 0) {
        return currentDomains.every(domain => domain.size === 1)
          ? currentDomains.map(domain => domain.values().next().value)
          : null;
      }

      const maxDegree = Math.max(...choices.map(choice => choice.degree));
      const mostConstrained = choices.filter(choice => choice.degree === maxDegree);
      const cell = mostConstrained[Math.floor(Math.random() * mostConstrained.length)].cell;
      const frame = {
        cell,
        domains: cloneDomains(currentDomains),
        candidates: orderCandidates(cell, currentDomains, columns, rows),
        nextCandidate: 0
      };
      stack.push(frame);
      currentDomains = nextBranch(frame, columns, rows);

      while (!currentDomains) {
        stack.pop();
        if (stack.length === 0) return null;
        currentDomains = nextBranch(stack[stack.length - 1], columns, rows);
      }

      decisions++;
      if (decisions % 100 === 0) {
        showStatus(`Searching for a consistent pattern… (${decisions} choices)`);
        await new Promise(resolve => setTimeout(resolve, 0));
      }
    }
  }

  async function generate() {
    if (tiles.length === 0 || isGenerating) return;
    isGenerating = true;
    renderTiles();
    showStatus('Finding a pattern…');
    buildVariants();

    const { columns, rows } = gridSize();
    const solution = await solveAttempt(columns, rows);

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
    const cols = Math.floor(sheetImage.naturalWidth / width);
    const rows = Math.floor(sheetImage.naturalHeight / height);
    if (cols < 1 || rows < 1) {
      showStatus('Tile dimensions are larger than the spritesheet', true);
      return;
    }
    els.tileWidth.value = String(width);
    els.tileHeight.value = String(height);
    resizeTiles(width, height);
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

  function saveConfiguration() {
    try {
      const config = {
        format: 'tilefield-config',
        version: 1,
        tileSize: cellSize(),
        grid: gridSize(),
        options: {
          edgeMatching: els.edgeMatching.checked,
          edgeTolerance: Number(els.edgeTolerance.value),
          cornerTolerance: Number(els.cornerTolerance.value),
          allowRotations: els.allowRotations.checked
        },
        selectedTileId,
        selectedRotation,
        tiles: tiles.map(tile => ({
          id: tile.id,
          name: tile.name,
          enabled: tile.enabled,
          image: tile.canvas.toDataURL('image/png'),
          rules: tile.rules.map(rule => [...rule])
        })),
        pins: [...pins].map(([cell, pin]) => ({ cell, ...pin }))
      };
      const blob = new Blob([JSON.stringify(config, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = 'tilefield-config.json';
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      showStatus('Configuration saved');
    } catch (error) {
      showStatus(`Could not save configuration: ${error.message}`, true);
    }
  }

  function validateConfiguration(config) {
    const isIntegerInRange = (value, min, max) => Number.isInteger(value) && value >= min && value <= max;
    if (!config || config.format !== 'tilefield-config' || config.version !== 1) {
      throw new Error('This is not a supported Tilefield configuration.');
    }
    if (!config.tileSize || !isIntegerInRange(config.tileSize.width, 1, 256) ||
      !isIntegerInRange(config.tileSize.height, 1, 256)) {
      throw new Error('The configuration has invalid tile dimensions.');
    }
    if (!config.grid || !isIntegerInRange(config.grid.columns, 1, 60) ||
      !isIntegerInRange(config.grid.rows, 1, 60)) {
      throw new Error('The configuration has invalid grid dimensions.');
    }
    if (!config.options || typeof config.options.edgeMatching !== 'boolean' ||
      typeof config.options.allowRotations !== 'boolean' || !Array.isArray(config.tiles) ||
      config.tiles.length === 0 || !Array.isArray(config.pins)) {
      throw new Error('The configuration is missing required settings or tiles.');
    }
    for (const tolerance of ['edgeTolerance', 'cornerTolerance']) {
      if (config.options[tolerance] !== undefined &&
        (!Number.isInteger(config.options[tolerance]) || config.options[tolerance] < 0 || config.options[tolerance] > 100)) {
        throw new Error(`The configuration has an invalid ${tolerance}.`);
      }
    }

    const ids = new Set();
    for (const tile of config.tiles) {
      if (!tile || typeof tile.id !== 'string' || tile.id.length === 0 || ids.has(tile.id) ||
        typeof tile.name !== 'string' || typeof tile.enabled !== 'boolean' ||
        typeof tile.image !== 'string' || !/^data:image\/[^;,]+;base64,/i.test(tile.image) ||
        !Array.isArray(tile.rules) || tile.rules.length !== 4 ||
        tile.rules.some(rule => !Array.isArray(rule) || rule.some(id => typeof id !== 'string'))) {
        throw new Error('The configuration contains an invalid tile.');
      }
      ids.add(tile.id);
    }
    for (const tile of config.tiles) {
      for (const rule of tile.rules) {
        if (rule.some(id => !ids.has(id))) throw new Error('A tile rule references a missing tile.');
      }
    }
    const enabledIds = new Set(config.tiles.filter(tile => tile.enabled).map(tile => tile.id));
    const maxCell = config.grid.columns * config.grid.rows;
    const pinnedCells = new Set();
    for (const pin of config.pins) {
      if (!pin || !isIntegerInRange(pin.cell, 0, maxCell - 1) || pinnedCells.has(pin.cell) ||
        !enabledIds.has(pin.tileId) || ![0, 90, 180, 270].includes(pin.rotation) ||
        (!config.options.allowRotations && pin.rotation !== 0)) {
        throw new Error('The configuration contains an invalid pinned tile.');
      }
      pinnedCells.add(pin.cell);
    }
    if (config.selectedTileId !== null && !enabledIds.has(config.selectedTileId)) {
      throw new Error('The selected tile is missing or excluded in the configuration.');
    }
    if (![0, 90, 180, 270].includes(config.selectedRotation) ||
      (!config.options.allowRotations && config.selectedRotation !== 0)) {
      throw new Error('The configuration has an invalid tile rotation.');
    }
  }

  async function loadConfiguration(file) {
    try {
      const config = JSON.parse(await file.text());
      validateConfiguration(config);
      if (tiles.length > 0 && !window.confirm('Loading a configuration replaces the current tiles and settings. Continue?')) {
        return;
      }

      const stagedTiles = await Promise.all(config.tiles.map(async savedTile => {
        const image = await loadImageDataUrl(savedTile.image);
        const canvas = createCanvas(config.tileSize.width, config.tileSize.height);
        const tileCtx = canvas.getContext('2d');
        tileCtx.imageSmoothingEnabled = false;
        tileCtx.drawImage(image, 0, 0, canvas.width, canvas.height);
        return {
          id: savedTile.id,
          name: savedTile.name,
          enabled: savedTile.enabled,
          canvas,
          rules: savedTile.rules.map(rule => new Set(rule))
        };
      }));

      tiles.splice(0, tiles.length, ...stagedTiles);
      pins.clear();
      for (const pin of config.pins) {
        pins.set(pin.cell, { tileId: pin.tileId, rotation: pin.rotation });
      }
      els.tileWidth.value = String(config.tileSize.width);
      els.tileHeight.value = String(config.tileSize.height);
      els.sliceWidth.value = String(config.tileSize.width);
      els.sliceHeight.value = String(config.tileSize.height);
      els.gridColumns.value = String(config.grid.columns);
      els.gridRows.value = String(config.grid.rows);
      previousGridSize = { ...config.grid };
      els.edgeMatching.checked = config.options.edgeMatching;
      els.edgeTolerance.value = String(config.options.edgeTolerance ?? 0);
      els.cornerTolerance.value = String(config.options.cornerTolerance ?? 0);
      els.allowRotations.checked = config.options.allowRotations;
      selectedTileId = config.selectedTileId;
      selectedRotation = config.selectedRotation;
      sheetImage = null;
      els.sheetOptions.hidden = true;
      invalidatePattern('Configuration loaded — generate to rebuild the pattern');
      renderAll();
    } catch (error) {
      showStatus(`Could not load configuration: ${error.message}`, true);
    }
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
  els.saveConfig.addEventListener('click', saveConfiguration);
  els.loadConfig.addEventListener('click', () => els.configFile.click());
  els.configFile.addEventListener('change', async event => {
    const file = event.target.files[0];
    if (file) await loadConfiguration(file);
    event.target.value = '';
  });
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
  els.edgeMatching.addEventListener('change', () => {
    els.edgeToleranceControls.hidden = !els.edgeMatching.checked;
    invalidatePattern('Rules changed — generate again');
  });
  for (const [input, output] of [
    [els.edgeTolerance, els.edgeToleranceValue],
    [els.cornerTolerance, els.cornerToleranceValue]
  ]) {
    input.addEventListener('input', () => {
      output.value = `${input.value}%`;
      invalidatePattern('Edge tolerance changed — generate again');
    });
  }
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
