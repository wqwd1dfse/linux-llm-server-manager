// Comprehensive SFTP File Explorer (Windows 11 Style)

let currentPath = '/root';
let pathHistory = ['/root'];
let historyIndex = 0;
let currentEditingPath = null;
let selectedPaths = new Set();
let clipboard = null; // { type: 'copy'|'cut', items: [...] }
let contextTarget = null; // { path, name, isDirectory }
const FILE_FAVORITES_PREFIX = 'server_manager_file_favorites_v1';

window.currentPath = currentPath;

window.initFiles = function () {
  loadFileList(currentPath);
  setupToolbarEvents();
  setupQuickPaths();
  setupFileFavorites();
  setupTrashManager();
  setupAddressBarInput();
  setupDragAndDrop();
  setupContextMenu();
  setupModals();
};

function setupToolbarEvents() {
  document.getElementById('cmd-btn-refresh')?.addEventListener('click', () => {
    if (window.currentView === 'files') loadFileList(currentPath);
  });

  document.getElementById('nav-btn-up')?.addEventListener('click', () => {
    if (currentPath !== '/' && window.currentView === 'files') {
      const parent = window.path.dirname(currentPath);
      navigateToDir(parent);
    }
  });

  document.getElementById('nav-btn-back')?.addEventListener('click', goHistoryBack);
  document.getElementById('nav-btn-forward')?.addEventListener('click', goHistoryForward);

  // Upload trigger
  const uploadInput = document.getElementById('file-upload-input');
  document.getElementById('cmd-btn-upload')?.addEventListener('click', () => {
    uploadInput?.click();
  });
  uploadInput?.addEventListener('change', handleFileUpload);

  // New Folder & File
  document.getElementById('cmd-btn-new-folder')?.addEventListener('click', () => {
    openNewItemModal('新建文件夹', '文件夹名称', async (name) => {
      const fullPath = window.path.join(currentPath, name);
      await window.api.request('/api/files/mkdir', {
        method: 'POST',
        body: JSON.stringify({ path: fullPath })
      });
      window.toast('文件夹创建成功', 'success');
      loadFileList(currentPath);
    });
  });

  document.getElementById('cmd-btn-new-file')?.addEventListener('click', () => {
    openNewItemModal('新建文件', '文件名', async (name) => {
      const fullPath = window.path.join(currentPath, name);
      await window.api.request('/api/files/create', {
        method: 'POST',
        body: JSON.stringify({ path: fullPath })
      });
      window.toast('文件创建成功', 'success');
      loadFileList(currentPath);
    });
  });
}

function setupQuickPaths() {
  document.querySelectorAll('.quick-path-chip').forEach(chip => {
    chip.addEventListener('click', () => {
      const p = chip.getAttribute('data-path');
      if (p) navigateToDir(p);
    });
  });
}

function getFavoritesStorageKey() {
  const cfg = window.serverConnectionConfig || {};
  const serverKey = `${cfg.username || 'user'}@${cfg.host || 'unknown'}:${cfg.port || 22}`;
  return `${FILE_FAVORITES_PREFIX}:${serverKey}`;
}

function getFileFavorites() {
  try {
    const parsed = JSON.parse(localStorage.getItem(getFavoritesStorageKey()) || '[]');
    return Array.isArray(parsed) ? parsed.filter(p => typeof p === 'string' && p.startsWith('/')).slice(0, 12) : [];
  } catch (_) {
    return [];
  }
}

function saveFileFavorites(favorites) {
  localStorage.setItem(getFavoritesStorageKey(), JSON.stringify([...new Set(favorites)].slice(0, 12)));
}

function renderFileFavorites() {
  const container = document.getElementById('file-favorites-container');
  const toggleButton = document.getElementById('btn-toggle-file-favorite');
  const favorites = getFileFavorites();
  if (toggleButton) {
    const active = favorites.includes(currentPath);
    toggleButton.innerText = active ? '★ 已收藏' : '☆ 收藏当前目录';
    toggleButton.classList.toggle('primary', active);
  }
  if (!container) return;
  container.replaceChildren();

  for (const favoritePath of favorites) {
    const chip = document.createElement('span');
    chip.className = 'file-favorite-chip';

    const openButton = document.createElement('button');
    openButton.type = 'button';
    openButton.title = favoritePath;
    openButton.textContent = `⭐ ${window.path.basename(favoritePath) || '/'}`;
    openButton.addEventListener('click', () => navigateToDir(favoritePath));

    const removeButton = document.createElement('button');
    removeButton.type = 'button';
    removeButton.className = 'file-favorite-remove';
    removeButton.setAttribute('aria-label', `取消收藏 ${favoritePath}`);
    removeButton.textContent = '×';
    removeButton.addEventListener('click', () => {
      saveFileFavorites(getFileFavorites().filter(item => item !== favoritePath));
      renderFileFavorites();
    });

    chip.append(openButton, removeButton);
    container.appendChild(chip);
  }
}

function setupFileFavorites() {
  document.getElementById('btn-toggle-file-favorite')?.addEventListener('click', () => {
    const favorites = getFileFavorites();
    if (favorites.includes(currentPath)) {
      saveFileFavorites(favorites.filter(item => item !== currentPath));
      window.toast('已取消收藏当前目录', 'info');
    } else {
      saveFileFavorites([...favorites, currentPath]);
      window.toast('已收藏当前目录', 'success');
    }
    renderFileFavorites();
  });
  renderFileFavorites();
}

async function loadTrashItems() {
  const tbody = document.getElementById('trash-items-body');
  if (!tbody) return;
  tbody.innerHTML = '<tr><td colspan="4" style="text-align:center;">正在读取远程回收站...</td></tr>';

  try {
    const res = await window.api.request('/api/files/trash');
    const items = res.data?.items || [];
    const location = document.getElementById('trash-location-label');
    if (location) location.innerText = `${res.data?.trashDir || '远程回收站'} · ${items.length} 项`;

    if (items.length === 0) {
      tbody.innerHTML = '<tr><td colspan="4" style="text-align:center; padding:30px; color:var(--win-text-muted);">回收站为空</td></tr>';
      return;
    }

    tbody.replaceChildren();
    for (const item of items) {
      const row = document.createElement('tr');

      const nameCell = document.createElement('td');
      nameCell.textContent = `${item.isDirectory ? '📁' : '📄'} ${item.originalName}`;

      const pathCell = document.createElement('td');
      pathCell.className = 'trash-original-path';
      pathCell.textContent = item.originalPath;

      const timeCell = document.createElement('td');
      timeCell.textContent = item.deletedAt ? new Date(item.deletedAt).toLocaleString() : '--';

      const actionCell = document.createElement('td');
      const restoreButton = document.createElement('button');
      restoreButton.className = 'cmd-btn btn-sm primary';
      restoreButton.textContent = '恢复';
      restoreButton.addEventListener('click', () => restoreTrashItem(item.id));

      const deleteButton = document.createElement('button');
      deleteButton.className = 'cmd-btn btn-sm danger';
      deleteButton.textContent = '永久删除';
      deleteButton.addEventListener('click', () => permanentlyDeleteTrashItem(item.id, item.originalName));

      actionCell.append(restoreButton, deleteButton);
      row.append(nameCell, pathCell, timeCell, actionCell);
      tbody.appendChild(row);
    }
  } catch (err) {
    tbody.innerHTML = `<tr><td colspan="4" style="text-align:center; color:var(--perf-red);">读取失败: ${window.escapeHtml(err.message)}</td></tr>`;
  }
}

async function restoreTrashItem(id) {
  try {
    const res = await window.api.request(`/api/files/trash/${encodeURIComponent(id)}/restore`, { method: 'POST' });
    window.toast(res.message, 'success');
    await loadTrashItems();
    loadFileList(currentPath, false);
  } catch (_) {}
}

async function permanentlyDeleteTrashItem(id, name) {
  if (!confirm(`确定永久删除“${name}”吗？此操作无法恢复。`)) return;
  try {
    const res = await window.api.request(`/api/files/trash/${encodeURIComponent(id)}`, { method: 'DELETE' });
    window.toast(res.message, 'success');
    loadTrashItems();
  } catch (_) {}
}

function setupTrashManager() {
  document.getElementById('btn-open-trash')?.addEventListener('click', () => {
    window.showModal('modal-file-trash');
    loadTrashItems();
  });
  document.getElementById('btn-empty-trash')?.addEventListener('click', async () => {
    if (!confirm('确定永久清空远程回收站吗？此操作无法恢复。')) return;
    try {
      const res = await window.api.request('/api/files/trash', { method: 'DELETE' });
      window.toast(res.message, 'success');
      loadTrashItems();
    } catch (_) {}
  });
}

window.refreshFileServerContext = function () {
  currentPath = '/root';
  pathHistory = ['/root'];
  historyIndex = 0;
  window.currentPath = currentPath;
  renderFileFavorites();
  loadFileList(currentPath, false);
};

function setupAddressBarInput() {
  const box = document.getElementById('address-bar-box');
  if (!box) return;

  box.addEventListener('dblclick', () => {
    const curr = currentPath;
    box.innerHTML = `<input type="text" id="direct-path-input" style="width: 100%; background: none; border: none; outline: none; color: var(--win-text-primary); font-size: 12px; font-family: var(--font-mono);" value="${window.escapeHtml(curr)}">`;
    const input = document.getElementById('direct-path-input');
    if (!input) return;
    input.focus();
    input.select();

    const finish = () => {
      const val = input.value.trim() || '/';
      navigateToDir(val);
    };

    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') finish();
      if (e.key === 'Escape') renderAddressBar(currentPath);
    });
    input.addEventListener('blur', finish);
  });
}

function setupDragAndDrop() {
  const container = document.getElementById('view-files');
  const overlay = document.getElementById('dropzone-overlay');
  if (!container || !overlay) return;

  container.addEventListener('dragover', (e) => {
    e.preventDefault();
    e.stopPropagation();
    overlay.classList.add('active');
  });

  container.addEventListener('dragleave', (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (e.target === container || e.target === overlay) {
      overlay.classList.remove('active');
    }
  });

  container.addEventListener('drop', async (e) => {
    e.preventDefault();
    e.stopPropagation();
    overlay.classList.remove('active');

    const files = e.dataTransfer.files;
    if (files && files.length > 0) {
      uploadMultipleFiles(files);
    }
  });
}

async function loadFileList(targetPath, recordHistory = true) {
  const tbody = document.getElementById('files-table-body');
  if (!tbody) return;
  tbody.innerHTML = '<tr><td colspan="7" style="text-align: center; color: var(--win-text-muted);">正在加载文件列表...</td></tr>';
  selectedPaths.clear();
  updateSelectionToolbar();

  try {
    const res = await window.api.request(`/api/files/list?path=${encodeURIComponent(targetPath)}`);
    currentPath = res.data.currentPath;
    window.currentPath = currentPath;

    if (recordHistory && (pathHistory[historyIndex] !== currentPath)) {
      pathHistory = pathHistory.slice(0, historyIndex + 1);
      pathHistory.push(currentPath);
      historyIndex = pathHistory.length - 1;
    }

    renderAddressBar(currentPath);
    renderFileFavorites();

    const files = res.data.files;
    if (files.length === 0) {
      tbody.innerHTML = '<tr><td colspan="7" style="text-align: center; color: var(--win-text-muted); padding: 30px;">此文件夹为空</td></tr>';
      return;
    }

    tbody.innerHTML = '';
    for (const f of files) {
      const tr = document.createElement('tr');
      tr.setAttribute('data-path', f.path);
      tr.setAttribute('data-name', f.name);
      tr.setAttribute('data-isdir', f.isDirectory ? 'true' : 'false');

      tr.addEventListener('contextmenu', (e) => {
        handleRowContextMenu(e, f.path, f.name, f.isDirectory);
      });

      const isArch = isArchiveFile(f.name);
      const isImg = isImageFile(f.name);
      const icon = f.isDirectory ? '📁' : getFileIcon(f.name);
      const sizeStr = f.isDirectory ? '' : formatBytes(f.size);
      const dateStr = f.modifyTime ? new Date(f.modifyTime).toLocaleString() : '--';
      const fileType = f.isDirectory ? '文件夹' : getFileTypeLabel(f.name);
      tr.tabIndex = 0;
      tr.setAttribute('aria-label', `${fileType}: ${f.name}`);
      tr.addEventListener('keydown', (event) => {
        if (event.target !== tr) return;
        if (event.key === 'Enter') {
          event.preventDefault();
          if (f.isDirectory) navigateToDir(f.path);
          else if (isImg) previewImage(f.path, f.name);
          else openFileEditor(f.path);
        } else if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) {
          event.preventDefault();
          const rect = tr.getBoundingClientRect();
          handleRowContextMenu({
            preventDefault() {},
            clientX: rect.left + Math.min(rect.width / 2, 240),
            clientY: rect.top + Math.min(rect.height, 32)
          }, f.path, f.name, f.isDirectory);
        }
      });


      // Checkbox cell
      const tdCheck = document.createElement('td');
      tdCheck.style.textAlign = 'center';
      tdCheck.style.width = '36px';
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.className = 'file-row-check';
      cb.value = f.path;
      cb.addEventListener('change', () => toggleRowSelect(f.path, cb.checked));
      tdCheck.appendChild(cb);
      tr.appendChild(tdCheck);

      // Name & Icon cell
      const tdName = document.createElement('td');
      const iconSpan = document.createElement('span');
      iconSpan.style.fontSize = '14px';
      iconSpan.style.marginRight = '6px';
      iconSpan.textContent = icon;
      tdName.appendChild(iconSpan);

      if (f.isDirectory) {
        const link = document.createElement('a');
        link.href = 'javascript:void(0)';
        link.style.fontWeight = '600';
        link.textContent = f.name;
        link.addEventListener('click', () => navigateToDir(f.path));
        tdName.appendChild(link);
      } else if (isImg) {
        const link = document.createElement('a');
        link.href = 'javascript:void(0)';
        link.style.color = 'var(--win-text-primary)';
        link.textContent = f.name;
        link.addEventListener('click', () => previewImage(f.path, f.name));
        tdName.appendChild(link);
      } else {
        const link = document.createElement('a');
        link.href = 'javascript:void(0)';
        link.style.color = 'var(--win-text-primary)';
        link.textContent = f.name;
        link.addEventListener('click', () => openFileEditor(f.path));
        tdName.appendChild(link);
      }
      tr.appendChild(tdName);

      // Date cell
      const tdDate = document.createElement('td');
      tdDate.style.color = 'var(--win-text-secondary)';
      tdDate.style.fontSize = '11px';
      tdDate.textContent = dateStr;
      tr.appendChild(tdDate);

      // Type cell
      const tdType = document.createElement('td');
      tdType.style.color = 'var(--win-text-secondary)';
      tdType.style.fontSize = '11px';
      tdType.textContent = fileType;
      tr.appendChild(tdType);

      // Size cell
      const tdSize = document.createElement('td');
      tdSize.style.fontFamily = 'var(--font-mono)';
      tdSize.style.fontSize = '11px';
      tdSize.style.textAlign = 'right';
      tdSize.style.color = 'var(--win-text-primary)';
      tdSize.textContent = sizeStr;
      tr.appendChild(tdSize);

      // Perms cell
      const tdPerm = document.createElement('td');
      tdPerm.style.fontFamily = 'var(--font-mono)';
      tdPerm.style.fontSize = '11px';
      tdPerm.style.color = 'var(--win-text-secondary)';
      tdPerm.textContent = f.permissions;
      tr.appendChild(tdPerm);

      // Actions cell
      const tdActions = document.createElement('td');
      const actionGroup = document.createElement('div');
      actionGroup.style.display = 'flex';
      actionGroup.style.gap = '4px';

      if (!f.isDirectory) {
        const btnEdit = document.createElement('button');
        btnEdit.className = 'cmd-btn btn-sm';
        btnEdit.textContent = '编辑';
        btnEdit.addEventListener('click', () => openFileEditor(f.path));
        actionGroup.appendChild(btnEdit);

        const btnDl = document.createElement('button');
        btnDl.className = 'cmd-btn btn-sm';
        btnDl.textContent = '下载';
        btnDl.addEventListener('click', () => downloadFile(f.path));
        actionGroup.appendChild(btnDl);
      }

      if (isArch) {
        const btnExtract = document.createElement('button');
        btnExtract.className = 'cmd-btn btn-sm';
        btnExtract.style.color = 'var(--win-accent)';
        btnExtract.textContent = '解压';
        btnExtract.addEventListener('click', () => extractArchive(f.path));
        actionGroup.appendChild(btnExtract);
      }

      const btnProp = document.createElement('button');
      btnProp.className = 'cmd-btn btn-sm';
      btnProp.textContent = '属性';
      btnProp.addEventListener('click', () => showPropertiesModal(f.path));
      actionGroup.appendChild(btnProp);

      const btnDel = document.createElement('button');
      btnDel.className = 'cmd-btn btn-sm danger';
      btnDel.textContent = '删除';
      btnDel.addEventListener('click', () => deleteItem(f.path, f.isDirectory));
      actionGroup.appendChild(btnDel);

      tdActions.appendChild(actionGroup);
      tr.appendChild(tdActions);

      tbody.appendChild(tr);
    }
  } catch (err) {
    tbody.innerHTML = `<tr><td colspan="7" style="text-align: center; color: var(--perf-red); padding: 30px;">无法读取目录: ${window.escapeHtml(err.message)}</td></tr>`;
  }
}

// Multi-select helpers
window.toggleSelectAll = function (checked) {
  document.querySelectorAll('.file-row-check').forEach(cb => {
    cb.checked = checked;
    const p = cb.value;
    if (checked) selectedPaths.add(p);
    else selectedPaths.delete(p);
  });
  updateSelectionToolbar();
};

window.toggleRowSelect = function (pathStr, checked) {
  if (checked) selectedPaths.add(pathStr);
  else selectedPaths.delete(pathStr);
  updateSelectionToolbar();
};

function updateSelectionToolbar() {
  const count = selectedPaths.size;
  const badge = document.getElementById('selected-items-badge');
  const batchBtns = document.getElementById('batch-actions-group');
  if (badge) badge.innerText = count > 0 ? `已选择 ${count} 项` : '';
  if (batchBtns) batchBtns.style.display = count > 0 ? 'flex' : 'none';

  const master = document.getElementById('select-all-checkbox');
  if (master) {
    const all = document.querySelectorAll('.file-row-check');
    master.checked = all.length > 0 && selectedPaths.size === all.length;
  }
}

// Context Menu (Right-Click)
function setupContextMenu() {
  const menu = document.getElementById('file-context-menu');
  if (!menu) return;

  menu.addEventListener('keydown', (event) => {
    const items = [...menu.querySelectorAll('[role="menuitem"]')]
      .filter((item) => item.offsetParent !== null);
    const current = items.indexOf(document.activeElement);
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      const offset = event.key === 'ArrowDown' ? 1 : -1;
      items[(current + offset + items.length) % items.length]?.focus();
    } else if (event.key === 'Escape') {
      event.preventDefault();
      menu.classList.remove('show');
    }
  });

  document.addEventListener('click', (e) => {
    if (!menu.contains(e.target)) {
      menu.classList.remove('show');
    }
  });

  window.handleRowContextMenu = function (e, pathStr, name, isDir) {
    e.preventDefault();
    contextTarget = { path: pathStr, name, isDirectory: isDir };

    menu.style.left = `${Math.min(e.clientX, window.innerWidth - 180)}px`;
    menu.style.top = `${Math.min(e.clientY, window.innerHeight - 300)}px`;
    menu.classList.add('show');

    requestAnimationFrame(() => menu.querySelector('[role="menuitem"]')?.focus());
    const isArch = isArchiveFile(name);
    const extractItem = document.getElementById('ctx-item-extract');
    if (extractItem) extractItem.style.display = isArch ? 'flex' : 'none';
  };
}

// Clipboard (Copy / Cut / Paste)
window.copySelection = function (isCut = false) {
  const items = selectedPaths.size > 0 ? Array.from(selectedPaths) : (contextTarget ? [contextTarget.path] : []);
  if (items.length === 0) return window.toast('请先选择要操作的文件', 'warning');

  clipboard = { type: isCut ? 'cut' : 'copy', items };
  window.toast(`已${isCut ? '剪切' : '复制'} ${items.length} 个项目`, 'info');
  updateClipboardButton();
};

window.pasteClipboard = async function () {
  if (!clipboard || clipboard.items.length === 0) {
    return window.toast('剪贴板为空', 'warning');
  }

  const { type, items } = clipboard;
  window.toast(`正在粘贴 ${items.length} 个项目...`, 'info');

  try {
    for (const src of items) {
      const dest = window.path.join(currentPath, window.path.basename(src));
      if (type === 'cut') {
        await window.api.request('/api/files/move', { method: 'POST', body: JSON.stringify({ source: src, destination: dest }) });
      } else {
        await window.api.request('/api/files/copy', { method: 'POST', body: JSON.stringify({ source: src, destination: dest }) });
      }
    }
    window.toast('粘贴完成!', 'success');
    if (type === 'cut') clipboard = null;
    updateClipboardButton();
    loadFileList(currentPath);
  } catch (_) {}
};

function updateClipboardButton() {
  const btn = document.getElementById('cmd-btn-paste');
  if (btn) {
    btn.style.display = clipboard && clipboard.items.length > 0 ? 'inline-flex' : 'none';
    if (clipboard) {
      btn.innerText = `📋 粘贴 (${clipboard.items.length})`;
    }
  }
}

// Batch Actions
window.batchDelete = async function () {
  const items = Array.from(selectedPaths);
  if (items.length === 0) return;

  if (!confirm(`确定要永久批量删除选中的 ${items.length} 个项目吗？`)) return;

  try {
    await window.api.request('/api/files/batch-delete', {
      method: 'POST',
      body: JSON.stringify({ paths: items })
    });
    window.toast(`已成功删除 ${items.length} 个项目`, 'success');
    loadFileList(currentPath);
  } catch (_) {}
};

window.batchCompress = function () {
  const items = selectedPaths.size > 0 ? Array.from(selectedPaths) : (contextTarget ? [contextTarget.path] : []);
  if (items.length === 0) return window.toast('请选择要压缩的项目', 'warning');

  const outputNameInput = document.getElementById('compress-output-name');
  if (outputNameInput) outputNameInput.value = `archive_${Date.now()}.tar.gz`;
  window.showModal('modal-compress');

  const btnConfirm = document.getElementById('btn-confirm-compress');
  if (btnConfirm) {
    btnConfirm.onclick = async () => {
      const outputName = document.getElementById('compress-output-name')?.value.trim();
      const format = document.getElementById('compress-format')?.value;
      if (!outputName) return window.toast('请输入压缩包名称', 'warning');

      window.toast('正在压缩...', 'info');
      try {
        await window.api.request('/api/files/compress', {
          method: 'POST',
          body: JSON.stringify({
            targetDir: currentPath,
            items,
            outputName,
            format
          })
        });
        window.toast('压缩成功!', 'success');
        window.closeModal('modal-compress');
        loadFileList(currentPath);
      } catch (_) {}
    };
  }
};

window.extractArchive = async function (filePath) {
  const target = filePath || (contextTarget ? contextTarget.path : null);
  if (!target) return;

  const base = window.path.basename(target);
  if (!confirm(`确定解压 ${base} 到当前目录吗？`)) return;

  window.toast('正在解压...', 'info');
  try {
    await window.api.request('/api/files/extract', {
      method: 'POST',
      body: JSON.stringify({
        filePath: target,
        targetDir: currentPath
      })
    });
    window.toast('解压成功!', 'success');
    loadFileList(currentPath);
  } catch (_) {}
};

// Permissions (Chmod Modal)
window.showChmodModal = function (targetPath) {
  const p = targetPath || (contextTarget ? contextTarget.path : null);
  if (!p) return;

  const targetEl = document.getElementById('chmod-target-path');
  if (targetEl) targetEl.innerText = p;
  window.showModal('modal-chmod');

  const calcOctal = () => {
    let u = 0, g = 0, o = 0;
    if (document.getElementById('perm-ur')?.checked) u += 4;
    if (document.getElementById('perm-uw')?.checked) u += 2;
    if (document.getElementById('perm-ux')?.checked) u += 1;

    if (document.getElementById('perm-gr')?.checked) g += 4;
    if (document.getElementById('perm-gw')?.checked) g += 2;
    if (document.getElementById('perm-gx')?.checked) g += 1;

    if (document.getElementById('perm-or')?.checked) o += 4;
    if (document.getElementById('perm-ow')?.checked) o += 2;
    if (document.getElementById('perm-ox')?.checked) o += 1;

    const octalInput = document.getElementById('chmod-octal-input');
    if (octalInput) octalInput.value = `0${u}${g}${o}`;
  };

  document.querySelectorAll('.perm-matrix input[type="checkbox"]').forEach(cb => {
    cb.onchange = calcOctal;
  });

  calcOctal();

  const confirmBtn = document.getElementById('btn-confirm-chmod');
  if (confirmBtn) {
    confirmBtn.onclick = async () => {
      const mode = (document.getElementById('chmod-octal-input')?.value || '').replace(/^0/, '');
      const recursive = document.getElementById('chmod-recursive-check')?.checked;

      try {
        await window.api.request('/api/files/chmod', {
          method: 'POST',
          body: JSON.stringify({ path: p, mode, recursive })
        });
        window.toast('权限修改成功!', 'success');
        window.closeModal('modal-chmod');
        loadFileList(currentPath);
      } catch (_) {}
    };
  }
};

// Properties Modal
window.showPropertiesModal = async function (targetPath) {
  const p = targetPath || (contextTarget ? contextTarget.path : null);
  if (!p) return;

  document.getElementById('prop-path').innerText = p;
  document.getElementById('prop-size').innerText = '正在计算...';
  document.getElementById('prop-owner').innerText = '加载中...';
  document.getElementById('prop-modify').innerText = '加载中...';
  document.getElementById('prop-perm').innerText = '加载中...';
  window.showModal('modal-properties');

  try {
    const res = await window.api.request(`/api/files/properties?path=${encodeURIComponent(p)}`);
    const d = res.data;
    document.getElementById('prop-size').innerText = `${d.diskSize} (${d.exactBytes.toLocaleString()} 字节)`;
    document.getElementById('prop-owner').innerText = `${d.owner}:${d.group}`;
    document.getElementById('prop-modify').innerText = d.modifyTime;
    document.getElementById('prop-perm').innerText = `${d.octalPerm}`;
  } catch (err) {
    document.getElementById('prop-size').innerText = `获取失败: ${err.message}`;
  }
};

// Image Preview Modal
window.previewImage = function (filePath, name) {
  document.getElementById('image-preview-title').innerText = name || filePath;
  const img = document.getElementById('image-preview-element');
  if (img) img.src = `/api/files/preview?path=${encodeURIComponent(filePath)}&t=${Date.now()}`;
  window.showModal('modal-image-preview');
};

function setupModals() {
  document.getElementById('btn-editor-save')?.addEventListener('click', handleSaveEditor);
}

// Upload multiple
async function uploadMultipleFiles(files) {
  const formData = new FormData();
  for (let i = 0; i < files.length; i++) {
    formData.append('files', files[i]);
  }
  formData.append('targetDir', currentPath);

  window.toast(`正在上传 ${files.length} 个文件...`, 'info');

  try {
    const res = await fetch('/api/files/upload', { method: 'POST', body: formData });
    const data = await res.json();
    if (!res.ok || !data.success) throw new Error(data.error || '上传失败');
    window.toast(data.message || '上传完成!', 'success');
    loadFileList(currentPath);
  } catch (e) {
    window.toast(`上传失败: ${e.message}`, 'error');
  }
}

async function handleFileUpload(e) {
  const files = e.target.files;
  if (files && files.length > 0) {
    await uploadMultipleFiles(files);
  }
  e.target.value = '';
}

// Navigation & Breadcrumbs
function goHistoryBack() {
  if (historyIndex > 0) {
    historyIndex--;
    loadFileList(pathHistory[historyIndex], false);
  }
}

function goHistoryForward() {
  if (historyIndex < pathHistory.length - 1) {
    historyIndex++;
    loadFileList(pathHistory[historyIndex], false);
  }
}

function renderAddressBar(p) {
  if (window.currentView !== 'files') return;
  if (window.renderAddressBarFiles) {
    window.renderAddressBarFiles(p);
  }
}

window.navigateToDir = function (dirPath) {
  loadFileList(dirPath);
};

window.openFileEditor = async function (filePath) {
  const p = filePath || (contextTarget ? contextTarget.path : null);
  if (!p) return;

  currentEditingPath = p;
  document.getElementById('editor-filename').innerText = p;
  const textarea = document.getElementById('editor-textarea');
  if (textarea) textarea.value = '正在加载文件内容...';
  window.showModal('modal-editor');

  try {
    const res = await window.api.request(`/api/files/read?path=${encodeURIComponent(p)}`);
    if (textarea) textarea.value = res.data.content;
  } catch (err) {
    if (textarea) textarea.value = `无法加载文件: ${err.message}`;
  }
};

async function handleSaveEditor() {
  if (!currentEditingPath) return;
  const content = document.getElementById('editor-textarea')?.value;
  const btn = document.getElementById('btn-editor-save');

  if (btn) {
    btn.disabled = true;
    btn.innerText = '正在保存...';
  }

  try {
    await window.api.request('/api/files/save', {
      method: 'POST',
      body: JSON.stringify({ path: currentEditingPath, content })
    });
    window.toast('文件已成功保存!', 'success');
    window.closeModal('modal-editor');
    loadFileList(currentPath);
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.innerText = '保存更改 (Ctrl+S)';
    }
  }
}

window.downloadFile = function (filePath) {
  const p = filePath || (contextTarget ? contextTarget.path : null);
  if (!p) return;
  window.open(`/api/files/download?path=${encodeURIComponent(p)}`, '_blank');
};

window.deleteItem = async function (targetPath, isDirectory) {
  const p = targetPath || (contextTarget ? contextTarget.path : null);
  if (!p) return;

  const isDir = isDirectory !== undefined ? isDirectory : (contextTarget ? contextTarget.isDirectory : false);
  const label = isDir ? '文件夹及其所有子项' : '文件';

  if (!confirm(`确定要永久删除此 ${label} 吗？\n${p}`)) return;

  try {
    await window.api.request('/api/files/delete', {
      method: 'POST',
      body: JSON.stringify({ path: p, isDirectory: isDir })
    });
    window.toast('已移入回收站', 'success');
    loadFileList(currentPath);
  } catch (_) {}
};

window.renameItem = async function (targetPath, oldName) {
  const p = targetPath || (contextTarget ? contextTarget.path : null);
  const name = oldName || (contextTarget ? contextTarget.name : (p ? window.path.basename(p) : ''));
  if (!p) return;

  const newName = prompt('输入新的名称:', name);
  if (!newName || newName === name) return;

  const parentDir = window.path.dirname(p);
  const newPath = newName.startsWith('/') ? newName : window.path.join(parentDir, newName);

  try {
    await window.api.request('/api/files/rename', {
      method: 'POST',
      body: JSON.stringify({ oldPath: p, newPath })
    });
    window.toast('重命名成功', 'success');
    loadFileList(currentPath);
  } catch (_) {}
};

function openNewItemModal(title, label, onConfirm) {
  document.getElementById('new-item-title').innerText = title;
  document.getElementById('new-item-label').innerText = label;
  const input = document.getElementById('new-item-name');
  if (input) input.value = '';

  const confirmBtn = document.getElementById('btn-confirm-new-item');
  if (confirmBtn) {
    confirmBtn.onclick = async () => {
      const val = input?.value.trim();
      if (!val) return window.toast('请输入名称', 'warning');
      await onConfirm(val);
      window.closeModal('modal-new-item');
    };
  }

  window.showModal('modal-new-item');
}

// Helpers
function getFileIcon(filename) {
  const ext = (filename || '').split('.').pop().toLowerCase();
  if (['sh', 'bash', 'zsh'].includes(ext)) return '📜';
  if (['conf', 'cfg', 'ini', 'env', 'yaml', 'yml', 'json', 'toml'].includes(ext)) return '⚙️';
  if (['log', 'txt', 'md'].includes(ext)) return '📝';
  if (['tar', 'gz', 'zip', '7z', 'bz2', 'tgz'].includes(ext)) return '📦';
  if (['js', 'ts', 'py', 'php', 'c', 'cpp', 'go', 'rs', 'java'].includes(ext)) return '💻';
  if (['png', 'jpg', 'jpeg', 'svg', 'gif', 'webp', 'ico'].includes(ext)) return '🖼️';
  return '📄';
}

function getFileTypeLabel(filename) {
  const ext = (filename || '').split('.').pop().toLowerCase();
  if (['sh', 'bash'].includes(ext)) return 'Shell 脚本';
  if (['conf', 'cfg', 'ini'].includes(ext)) return '配置文件';
  if (['json', 'yaml', 'yml'].includes(ext)) return '数据配置';
  if (['log'].includes(ext)) return '日志文件';
  if (['txt', 'md'].includes(ext)) return '文本文件';
  if (['tar', 'gz', 'zip', 'tgz', 'bz2'].includes(ext)) return '压缩包';
  if (['png', 'jpg', 'jpeg', 'svg', 'gif', 'webp'].includes(ext)) return '图像文件';
  return '文件';
}

function isArchiveFile(filename) {
  const lower = (filename || '').toLowerCase();
  return lower.endsWith('.tar.gz') || lower.endsWith('.zip') || lower.endsWith('.tgz') || lower.endsWith('.tar.bz2') || lower.endsWith('.tar');
}

function isImageFile(filename) {
  const lower = (filename || '').toLowerCase();
  return ['.png', '.jpg', '.jpeg', '.gif', '.svg', '.webp'].some(ext => lower.endsWith(ext));
}

function formatBytes(bytes) {
  if (!bytes || bytes === 0) return '0 KB';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
}
