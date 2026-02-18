// ---------------------------------------------------------------------------
// Imports — CDN only, no build step
// ---------------------------------------------------------------------------
import { h, render } from 'https://esm.sh/preact@10.25.4';
import { useState, useEffect, useRef, useCallback } from 'https://esm.sh/preact@10.25.4/hooks';
import { signal, computed, effect, batch } from 'https://esm.sh/@preact/signals@1.3.2?deps=preact@10.25.4';
import htm from 'https://esm.sh/htm@3.1.1';
import { Editor, rootCtx, defaultValueCtx } from 'https://esm.sh/@milkdown/kit@7.18.0/core';
import { commonmark } from 'https://esm.sh/@milkdown/kit@7.18.0/preset/commonmark';
import { nord } from 'https://esm.sh/@milkdown/theme-nord@7.18.0';
import { listener, listenerCtx } from 'https://esm.sh/@milkdown/kit@7.18.0/plugin/listener';
import { getMarkdown } from 'https://esm.sh/@milkdown/kit@7.18.0/utils';

const html = htm.bind(h);

// ---------------------------------------------------------------------------
// Worker bridge
// ---------------------------------------------------------------------------
const worker = new Worker('./worker.js', { type: 'module' });
const _pending = new Map();
let _msgId = 0;

function call(type, payload = {}) {
  return new Promise((resolve, reject) => {
    const id = _msgId++;
    _pending.set(id, { resolve, reject });
    worker.postMessage({ id, type, payload });
  });
}

worker.onmessage = ({ data }) => {
  if (data.type === 'ready') {
    workerReady.value = true;
    refresh();
    return;
  }
  if (data.type === 'error') {
    loadError.value = 'Failed to load database: ' + data.message;
    return;
  }
  const p = _pending.get(data.id);
  if (!p) return;
  _pending.delete(data.id);
  data.error ? p.reject(new Error(data.error)) : p.resolve(data.result);
};

worker.onerror = (e) => {
  loadError.value = 'Worker error: ' + e.message;
};

// ---------------------------------------------------------------------------
// DB State — signals
// ---------------------------------------------------------------------------
const workerReady  = signal(false);
const loadError    = signal(null);

const tables       = signal([]);
const activeTableId = signal(null);
const columns      = signal([]);
const rows         = signal([]);
const foreignKeys  = signal([]);
const fkOptionsMap = signal({});  // { col_id -> [{row_id, label}] }
const activeRowId  = signal(null);

// ---------------------------------------------------------------------------
// View State — signals
// ---------------------------------------------------------------------------
const sortState    = signal({ colName: null, dir: 'asc' });  // { colName, dir }
const searchQuery  = signal('');

// Modal state
const modalState   = signal(null);  // null | { type: 'cols'|'rels'|'confirm'|'prompt'|'general-confirm', ...data }

// Sidebar inline rename state
const renamingSidebar = signal(null);  // null | tableId

// Column inline rename state
const renamingCol     = signal(null);  // null | colId

// Expanded markdown row (accordion — one at a time)
const expandedRowId   = signal(null);  // null | rowId

// Pending tab navigation: set before save+refresh, consumed after render
let _pendingTabNav = null;

// ---------------------------------------------------------------------------
// Computed
// ---------------------------------------------------------------------------
const activeTable = computed(() =>
  tables.value.find(t => t.id === activeTableId.value) ?? null
);

const sortedFilteredRows = computed(() => {
  let r = rows.value;
  const q = searchQuery.value.toLowerCase().trim();
  if (q) {
    r = r.filter(row =>
      Object.values(row.cells).some(v =>
        v != null && String(v).toLowerCase().includes(q)
      )
    );
  }
  const { colName, dir } = sortState.value;
  if (!colName) return r;
  return [...r].sort((a, b) => {
    const av = (a.cells[colName] ?? '').toString().toLowerCase();
    const bv = (b.cells[colName] ?? '').toString().toLowerCase();
    if (av < bv) return dir === 'asc' ? -1 : 1;
    if (av > bv) return dir === 'asc' ? 1 : -1;
    return 0;
  });
});

// ---------------------------------------------------------------------------
// API object
// ---------------------------------------------------------------------------
const API = {
  getTables:        ()                             => call('get_tables'),
  addTable:         (name)                         => call('create_table',       { name }),
  renameTable:      (id, name)                     => call('rename_table',       { id, name }),
  deleteTable:      (id)                           => call('delete_table',       { id }),
  getColumns:       ()                             => call('get_columns',        { table_id: activeTableId.value }),
  addColumn:        (name, is_unique, col_type, col_choices) =>
                                                      call('create_column',      { table_id: activeTableId.value, name, is_unique, col_type, col_choices }),
  renameColumn:     (id, name)                     => call('rename_column',      { id, name }),
  setColumnUnique:  (id, is_unique)                => call('set_column_unique',  { id, is_unique }),
  setColumnType:    (id, col_type, col_choices)    => call('set_column_type',    { id, col_type, col_choices }),
  deleteColumn:     (id)                           => call('delete_column',      { id }),
  getRows:          ()                             => call('get_rows',           { table_id: activeTableId.value }),
  addRow:           (cells)                        => call('create_row',         { table_id: activeTableId.value, cells }),
  updateRow:        (rowId, cells)                 => call('update_row',         { table_id: activeTableId.value, row_id: rowId, cells }),
  deleteRow:        (rowId)                        => call('delete_row',         { table_id: activeTableId.value, row_id: rowId }),
  getHistory:       (rowId)                        => call('get_row_history',    { table_id: activeTableId.value, row_id: rowId }),
  getForeignKeys:   ()                             => call('get_foreign_keys',   { table_id: activeTableId.value }),
  addForeignKey:    (from_column_id, to_table_id)  => call('create_foreign_key', { from_column_id, to_table_id }),
  deleteForeignKey: (id)                           => call('delete_foreign_key', { id }),
  getFkOptions:     (column_id)                    => call('get_fk_options',     { column_id }),
};

// ---------------------------------------------------------------------------
// Toast
// ---------------------------------------------------------------------------
function toast(msg, type = 'error') {
  const container = document.getElementById('toast-container');
  const div = document.createElement('div');
  div.className = `toast ${type}`;
  div.textContent = msg;
  container.appendChild(div);
  setTimeout(() => div.remove(), 4000);
}

// ---------------------------------------------------------------------------
// Modal helpers (promise-based — same API as before)
// ---------------------------------------------------------------------------
function showPrompt(title, label, defaultValue = '') {
  return new Promise(resolve => {
    modalState.value = { type: 'prompt', title, label, defaultValue, resolve };
  });
}

function showConfirm(title, message, confirmLabel = 'Confirm', danger = false) {
  return new Promise(resolve => {
    modalState.value = { type: 'general-confirm', title, message, confirmLabel, danger, resolve };
  });
}

// ---------------------------------------------------------------------------
// Refresh
// ---------------------------------------------------------------------------
async function refresh() {
  const tbls = await API.getTables();
  tables.value = tbls;

  // Validate / auto-select active table
  let tid = activeTableId.value;
  if (tid !== null && !tbls.find(t => t.id === tid)) {
    tid = tbls.length > 0 ? tbls[0].id : null;
  }
  if (tid === null && tbls.length > 0) {
    tid = tbls[0].id;
  }
  activeTableId.value = tid;

  if (tid === null) {
    batch(() => {
      columns.value     = [];
      rows.value        = [];
      foreignKeys.value = [];
      fkOptionsMap.value = {};
    });
    return;
  }

  const [cols, rws, fks] = await Promise.all([
    API.getColumns(),
    API.getRows(),
    API.getForeignKeys(),
  ]);

  const fkColIds = fks.map(fk => fk.from_column_id);
  const fkOptResults = await Promise.all(fkColIds.map(id => API.getFkOptions(id)));
  const fkMap = {};
  fkColIds.forEach((id, i) => { fkMap[id] = fkOptResults[i]; });

  batch(() => {
    columns.value     = cols;
    rows.value        = rws;
    foreignKeys.value = fks;
    fkOptionsMap.value = fkMap;
  });
}

async function switchTable(tableId) {
  if (activeTableId.value === tableId) return;
  activeRowId.value = null;
  activeTableId.value = tableId;
  await refresh();
}

// ---------------------------------------------------------------------------
// Helper: row label (first non-empty cell value, FK-resolved)
// ---------------------------------------------------------------------------
function rowLabel(rowId) {
  const row = rows.value.find(r => r.row_id === rowId);
  if (!row) return rowId.slice(0, 8) + '…';
  for (const col of columns.value) {
    const val = row.cells[col.name];
    if (val && String(val).trim()) {
      const fkDef = foreignKeys.value.find(fk => fk.from_column_id === col.id);
      if (fkDef) {
        const opts = fkOptionsMap.value[fkDef.from_column_id] || [];
        const m = opts.find(o => o.row_id === val);
        return m ? m.label : val.slice(0, 8) + '…';
      }
      return String(val);
    }
  }
  return rowId.slice(0, 8) + '…';
}

function relativeTime(date) {
  const secs = Math.round((Date.now() - date.getTime()) / 1000);
  if (secs < 60)  return `${secs}s ago`;
  const mins = Math.round(secs / 60);
  if (mins < 60)  return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24)   return `${hrs}h ago`;
  return `${Math.round(hrs / 24)}d ago`;
}

// ---------------------------------------------------------------------------
// TYPE_LABELS — badges shown in column headers
// ---------------------------------------------------------------------------
const TYPE_LABELS = { number: '#', boolean: '✓', date: '📅', datetime: '🕐', url: '🔗', select: '▾', markdown: '📝' };

// ---------------------------------------------------------------------------
// Component: SidebarRenameInput
// ---------------------------------------------------------------------------
function SidebarRenameInput({ tableId, currentName, li }) {
  const inputRef = useRef(null);

  useEffect(() => {
    const el = inputRef.current;
    if (el) { el.focus(); el.select(); }
  }, []);

  let saved = false;
  const finish = async () => {
    if (saved) return; saved = true;
    const newName = inputRef.current?.value.trim();
    renamingSidebar.value = null;
    if (!newName || newName === currentName) return;
    try {
      await API.renameTable(tableId, newName);
      await refresh();
      toast(`Table renamed to "${newName}"`, 'success');
    } catch (err) {
      toast(err.message);
    }
  };

  const onKey = (e) => {
    if (e.key === 'Enter') { e.preventDefault(); finish(); }
    if (e.key === 'Escape') { saved = true; renamingSidebar.value = null; }
  };

  return html`<input
    ref=${inputRef}
    class="inline-rename-input"
    defaultValue=${currentName}
    onBlur=${finish}
    onKeyDown=${onKey}
  />`;
}

// ---------------------------------------------------------------------------
// Component: Sidebar
// ---------------------------------------------------------------------------
function Sidebar() {
  const tbls = tables.value;
  const activeTid = activeTableId.value;
  const renamingId = renamingSidebar.value;

  const handleNewTable = async () => {
    const name = await showPrompt('New Table', 'Table name:');
    if (!name) return;
    try {
      const result = await API.addTable(name);
      activeTableId.value = result.id;
      await refresh();
      toast(`Table "${name}" created`, 'success');
    } catch (err) {
      toast(err.message);
    }
  };

  const handleDeleteTable = async (id, name) => {
    const ok = await showConfirm(
      'Delete Table',
      `Delete table "${name}"? All columns will be soft-deleted. You must delete all rows first.`,
      'Delete', true
    );
    if (!ok) return;
    try {
      if (activeTableId.value === id) {
        activeTableId.value = null;
        activeRowId.value = null;
      }
      await API.deleteTable(id);
      await refresh();
      toast(`Table "${name}" deleted`, 'success');
    } catch (err) {
      toast(err.message);
    }
  };

  return html`
    <div id="table-sidebar">
      <div id="sidebar-header">Tables</div>
      <ul id="table-list">
        ${tbls.length === 0
          ? html`<li style="padding:12px 14px;color:#475569;font-size:12px">No tables yet.</li>`
          : tbls.map(tbl => html`
            <li
              key=${tbl.id}
              class=${'table-item' + (tbl.id === activeTid ? ' active' : '')}
              onClick=${() => switchTable(tbl.id)}
            >
              ${renamingId === tbl.id
                ? html`<${SidebarRenameInput} tableId=${tbl.id} currentName=${tbl.name} />`
                : html`<span class="table-item-name">${tbl.name}</span>`
              }
              <button
                class="btn-table-icon"
                title="Rename"
                onClick=${(e) => { e.stopPropagation(); renamingSidebar.value = tbl.id; }}
              >✎</button>
              <button
                class="btn-table-icon"
                title="Delete"
                onClick=${(e) => { e.stopPropagation(); handleDeleteTable(tbl.id, tbl.name); }}
              >×</button>
            </li>
          `)
        }
      </ul>
      <div id="sidebar-footer">
        <button id="btn-new-table" onClick=${handleNewTable}>+ New Table</button>
      </div>
    </div>
  `;
}

// ---------------------------------------------------------------------------
// Component: ColHeader (sortable, inline rename)
// ---------------------------------------------------------------------------
function ColHeader({ col, fkDef }) {
  const { colName, dir } = sortState.value;
  const isRenamingThis = renamingCol.value === col.id;
  const inputRef = useRef(null);

  useEffect(() => {
    if (isRenamingThis && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [isRenamingThis]);

  const handleSort = () => {
    if (renamingCol.value) return;
    sortState.value = colName === col.name
      ? { colName: col.name, dir: dir === 'asc' ? 'desc' : 'asc' }
      : { colName: col.name, dir: 'asc' };
  };

  const handleDblClick = (e) => {
    e.stopPropagation();
    renamingCol.value = col.id;
  };

  let sortClass = 'sortable';
  if (colName === col.name) sortClass += dir === 'asc' ? ' sort-asc' : ' sort-desc';

  if (isRenamingThis) {
    let saved = false;
    const finish = async () => {
      if (saved) return; saved = true;
      const newName = inputRef.current?.value.trim();
      renamingCol.value = null;
      if (!newName || newName === col.name) return;
      try {
        await API.renameColumn(col.id, newName);
        await refresh();
        toast(`Column renamed to "${newName}"`, 'success');
      } catch (err) {
        toast(err.message);
        await refresh();
      }
    };
    const onKey = (e) => {
      if (e.key === 'Enter') { e.preventDefault(); finish(); }
      if (e.key === 'Escape') { saved = true; renamingCol.value = null; }
    };
    return html`<th class=${sortClass}>
      <input
        ref=${inputRef}
        class="inline-rename-input"
        defaultValue=${col.name}
        onBlur=${finish}
        onKeyDown=${onKey}
      />
    </th>`;
  }

  const colType = col.col_type || 'text';

  return html`
    <th
      class=${sortClass}
      onClick=${handleSort}
      onDblClick=${handleDblClick}
    >
      ${col.name}
      ${col.is_unique ? html`<span class="col-badge col-badge-u" title="Unique constraint">U</span>` : null}
      ${fkDef ? html`<span class="col-badge col-badge-fk" title=${'FK → ' + fkDef.to_table_name}>FK</span>` : null}
      ${!fkDef && colType !== 'text' && TYPE_LABELS[colType]
        ? html`<span class="col-type-badge" title=${colType}>${TYPE_LABELS[colType]}</span>`
        : null
      }
    </th>
  `;
}

// ---------------------------------------------------------------------------
// Cell renderers (read-only display)
// ---------------------------------------------------------------------------
const CELL_RENDERERS = {
  boolean: (rawValue) => {
    const checked = rawValue === '1' || rawValue === 'true';
    return html`<span class="cell-bool-toggle" title=${checked ? 'True' : 'False'}>${checked ? '☑' : '☐'}</span>`;
  },
  url: (rawValue) => rawValue
    ? html`<a href=${rawValue} target="_blank" rel="noopener noreferrer"
             onClick=${(e) => e.stopPropagation()}>${rawValue}</a>`
    : null,
  date: (rawValue) => rawValue
    ? new Date(rawValue + 'T00:00:00').toLocaleDateString()
    : '',
  datetime: (rawValue) => rawValue
    ? new Date(rawValue).toLocaleString()
    : '',
  number: (rawValue) => rawValue,
  select: (rawValue) => rawValue || html`<span class="cell-fk-empty">— select —</span>`,
  text: (rawValue) => rawValue,
};

function getCellClass(colType, extraClass = '') {
  const map = {
    boolean: 'cell-bool cell-editable',
    url:     'cell-url cell-editable',
    number:  'cell-number cell-editable',
    select:  'cell-editable cell-fk',
  };
  return (map[colType] || 'cell-editable') + (extraClass ? ' ' + extraClass : '');
}

// ---------------------------------------------------------------------------
// Component: MarkdownExpander — inline Milkdown editor row
// ---------------------------------------------------------------------------
function MarkdownExpander({ row, mdCol, colCount }) {
  const containerRef = useRef(null);
  const editorRef    = useRef(null);
  const saveTimerRef = useRef(null);
  const rowId   = row.row_id;
  const colName = mdCol.name;
  const initialValue = row.cells[colName] ?? '';

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    let destroyed = false;

    Editor.make()
      .config((ctx) => {
        ctx.set(rootCtx, el);
        ctx.set(defaultValueCtx, initialValue);
        ctx.get(listenerCtx).markdownUpdated((ctx, markdown) => {
          clearTimeout(saveTimerRef.current);
          saveTimerRef.current = setTimeout(async () => {
            try {
              await API.updateRow(rowId, { [colName]: markdown });
              // Don't call refresh() — it would destroy the editor mid-type
              // Just silently update the in-memory row value
              const r = rows.value.find(r => r.row_id === rowId);
              if (r) r.cells[colName] = markdown;
            } catch (err) {
              toast(err.message);
            }
          }, 800);
        });
      })
      .config(nord)
      .use(commonmark)
      .use(listener)
      .create()
      .then(editor => {
        if (destroyed) { editor.destroy(); return; }
        editorRef.current = editor;
      })
      .catch(err => {
        if (!destroyed) toast('Editor error: ' + err.message);
      });

    return () => {
      destroyed = true;
      clearTimeout(saveTimerRef.current);
      if (editorRef.current) {
        editorRef.current.destroy();
        editorRef.current = null;
      }
    };
  // Run only when the row/column identity changes — not on every render
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rowId, colName]);

  return html`
    <tr class="content-expander-row">
      <td colspan=${colCount + 1} class="content-expander-td">
        <div class="content-expander-inner" ref=${containerRef}></div>
      </td>
    </tr>
  `;
}

// ---------------------------------------------------------------------------
// Component: DataCell — handles both display and editing
// ---------------------------------------------------------------------------
function DataCell({ col, row, fkDef }) {
  const [editing, setEditing] = useState(false);
  const colType = col.col_type || 'text';
  const rawValue = row.cells[col.name] ?? '';
  const colId = col.id;
  const colName = col.name;
  const rowId = row.row_id;

  // Markdown columns are hidden from the table — they render in the expander row
  if (colType === 'markdown') return null;

  // If this cell is in the pending tab nav target, auto-click it after mount
  const tdRef = useRef(null);
  useEffect(() => {
    if (!_pendingTabNav) return;
    // This is consumed by DataRow after render — see DataRow below
  }, []);

  const startEdit = useCallback(() => {
    if (editing) return;

    // Boolean: instant toggle
    if (!fkDef && colType === 'boolean') {
      const wasChecked = rawValue === '1' || rawValue === 'true';
      const newVal = wasChecked ? '0' : '1';
      API.updateRow(rowId, { [colName]: newVal })
        .then(() => refresh())
        .then(() => { if (activeRowId.value === rowId) return loadHistoryData(rowId); })
        .catch(err => { toast(err.message); refresh(); });
      return;
    }

    setEditing(true);
  }, [editing, colType, rawValue, rowId, colName, fkDef]);

  const stopEdit = useCallback(() => setEditing(false), []);

  if (editing) {
    return html`<${EditingCell}
      col=${col}
      row=${row}
      fkDef=${fkDef}
      rawValue=${rawValue}
      onDone=${stopEdit}
      tdRef=${tdRef}
    />`;
  }

  // Display mode
  if (fkDef) {
    const options = fkOptionsMap.value[colId] || [];
    const match = options.find(o => o.row_id === rawValue);
    if (rawValue && !match) {
      return html`<td
        ref=${tdRef}
        class="cell-stale-fk"
        title=${'Stale reference: ' + rawValue}
        onClick=${startEdit}
      >${rawValue.slice(0, 8)}… (deleted)</td>`;
    }
    return html`<td
      ref=${tdRef}
      class="cell-editable cell-fk"
      data-col-name=${colName}
      data-col-id=${colId}
      data-row-id=${rowId}
      data-is-fk="true"
      onClick=${startEdit}
    >
      ${match
        ? (match.label ?? rawValue.slice(0, 8) + '…')
        : html`<span class="cell-fk-empty">— select —</span>`
      }
    </td>`;
  }

  const renderer = CELL_RENDERERS[colType] || CELL_RENDERERS.text;
  return html`<td
    ref=${tdRef}
    class=${getCellClass(colType)}
    data-col-name=${colName}
    data-col-id=${colId}
    data-row-id=${rowId}
    data-col-type=${colType}
    onClick=${startEdit}
  >${renderer(rawValue)}</td>`;
}

// ---------------------------------------------------------------------------
// Component: EditingCell
// ---------------------------------------------------------------------------
function EditingCell({ col, row, fkDef, rawValue, onDone, tdRef }) {
  const colType = col.col_type || 'text';
  const colId = col.id;
  const colName = col.name;
  const rowId = row.row_id;
  const inputRef = useRef(null);
  const savedRef = useRef(false);

  useEffect(() => {
    const el = inputRef.current;
    if (el) {
      el.focus();
      if (el.select) el.select();
    }
  }, []);

  const saveValue = useCallback(async (newValue) => {
    if (savedRef.current) return;
    savedRef.current = true;
    onDone();

    if (newValue === rawValue) return;

    // Validate number
    if (colType === 'number' && newValue !== '' && isNaN(Number(newValue))) {
      toast('Must be a valid number');
      return;
    }

    try {
      await API.updateRow(rowId, { [colName]: newValue });
      await refresh();
      if (activeRowId.value === rowId) await loadHistoryData(rowId);
    } catch (err) {
      toast(err.message);
      await refresh();
    }
  }, [rawValue, colType, rowId, colName, onDone]);

  const handleKeyDown = useCallback((e) => {
    if (e.key === 'Enter') { e.preventDefault(); saveValue(inputRef.current?.value ?? ''); }
    if (e.key === 'Tab') {
      e.preventDefault();
      // Store pending tab nav before blur saves
      const tr = tdRef?.current?.parentElement;
      if (tr) {
        const allTds = [...tr.querySelectorAll('td')];
        const editable = allTds.filter(t =>
          t.classList.contains('cell-editable') || t.classList.contains('cell-fk')
        );
        const uniqueCells = [...new Set(editable)];
        const currentIdx = uniqueCells.indexOf(tdRef?.current);
        const nextIdx = e.shiftKey ? currentIdx - 1 : currentIdx + 1;
        if (currentIdx >= 0 && nextIdx >= 0 && nextIdx < uniqueCells.length) {
          _pendingTabNav = { rowId, cellIdx: nextIdx };
        }
      }
      saveValue(inputRef.current?.value ?? '');
    }
    if (e.key === 'Escape') {
      savedRef.current = true;
      onDone();
    }
  }, [saveValue, onDone, rowId, tdRef]);

  // FK dropdown
  if (fkDef) {
    const options = fkOptionsMap.value[colId] || [];
    const isStale = rawValue && !options.find(o => o.row_id === rawValue);

    const handleChange = (e) => {
      saveValue(e.target.value);
    };

    return html`<td ref=${tdRef} class="cell-editing" data-col-name=${colName} data-col-id=${colId} data-row-id=${rowId} data-is-fk="true">
      <select
        ref=${inputRef}
        onBlur=${(e) => saveValue(e.target.value)}
        onChange=${handleChange}
        onKeyDown=${(e) => { if (e.key === 'Escape') { savedRef.current = true; onDone(); } }}
      >
        <option value="">— none —</option>
        ${isStale ? html`<option value=${rawValue} selected>${rawValue.slice(0, 8)}… (deleted)</option>` : null}
        ${options.map(opt => html`
          <option key=${opt.row_id} value=${opt.row_id} selected=${opt.row_id === rawValue}>
            ${opt.label ?? opt.row_id.slice(0, 8) + '…'}
          </option>
        `)}
      </select>
    </td>`;
  }

  // Select dropdown
  if (colType === 'select') {
    const choices = (col.col_choices || '').split(',').map(s => s.trim()).filter(Boolean);
    const isCustom = rawValue && !choices.includes(rawValue);

    const handleChange = (e) => {
      saveValue(e.target.value);
    };

    return html`<td ref=${tdRef} class="cell-editing" data-col-name=${colName} data-col-id=${colId} data-row-id=${rowId} data-col-type="select">
      <select
        ref=${inputRef}
        onBlur=${(e) => saveValue(e.target.value)}
        onChange=${handleChange}
        onKeyDown=${(e) => { if (e.key === 'Escape') { savedRef.current = true; onDone(); } }}
      >
        <option value="">— none —</option>
        ${isCustom ? html`<option value=${rawValue} selected>${rawValue} (custom)</option>` : null}
        ${choices.map(c => html`<option key=${c} value=${c} selected=${c === rawValue}>${c}</option>`)}
      </select>
    </td>`;
  }

  // Regular input
  const inputType = { number: 'number', date: 'date', datetime: 'datetime-local', url: 'url' }[colType] || 'text';

  return html`<td ref=${tdRef} class="cell-editing" data-col-name=${colName} data-col-id=${colId} data-row-id=${rowId} data-col-type=${colType}>
    <input
      ref=${inputRef}
      type=${inputType}
      step=${colType === 'number' ? 'any' : colType === 'datetime' ? '1' : undefined}
      defaultValue=${rawValue}
      onBlur=${(e) => saveValue(e.target.value)}
      onKeyDown=${handleKeyDown}
    />
  </td>`;
}

// ---------------------------------------------------------------------------
// Component: DataRow
// ---------------------------------------------------------------------------
function DataRow({ row, colsList, fksList }) {
  const rowId = row.row_id;
  const isActive   = activeRowId.value === rowId;
  const isExpanded = expandedRowId.value === rowId;
  const trRef = useRef(null);

  // Markdown columns hidden from normal cells — find them for the expander
  const visibleCols  = colsList.filter(c => (c.col_type || 'text') !== 'markdown');
  const markdownCols = colsList.filter(c => (c.col_type || 'text') === 'markdown');
  const hasMdCol = markdownCols.length > 0;

  // Consume pending tab nav after render
  useEffect(() => {
    if (!_pendingTabNav) return;
    const { rowId: navRowId, cellIdx } = _pendingTabNav;
    if (navRowId !== rowId) return;
    _pendingTabNav = null;
    const tr = trRef.current;
    if (!tr) return;
    const allTds = [...tr.querySelectorAll('td')];
    const editable = allTds.filter(t =>
      t.classList.contains('cell-editable') || t.classList.contains('cell-fk')
    );
    const unique = [...new Set(editable)];
    const target = unique[cellIdx];
    if (target) requestAnimationFrame(() => target.click());
  });

  const openHistoryForRow = useCallback((e) => {
    e.stopPropagation();
    activeRowId.value = rowId;
    loadHistoryData(rowId);
  }, [rowId]);

  const confirmDelete = useCallback((e) => {
    e.stopPropagation();
    modalState.value = { type: 'confirm', rowId };
  }, [rowId]);

  // Row click (on the <tr> itself, not on cells) toggles expand
  const handleRowClick = useCallback((e) => {
    // Ignore if clicking an interactive element
    if (e.target.closest('td.cell-editable, td.cell-fk, td.cell-stale-fk, td.cell-bool, td.actions-td, button, input, select, a')) return;
    if (!hasMdCol) return;
    expandedRowId.value = isExpanded ? null : rowId;
  }, [isExpanded, rowId, hasMdCol]);

  const rowClass = [
    isActive ? 'active-history-row' : '',
    hasMdCol ? 'row-expandable' : '',
    isExpanded ? 'row-expanded' : '',
  ].filter(Boolean).join(' ');

  return html`
    <tr ref=${trRef} data-row-id=${rowId} class=${rowClass} onClick=${handleRowClick}>
      ${hasMdCol ? html`<td class="expand-chevron-td" onClick=${handleRowClick}>${isExpanded ? '▾' : '▸'}</td>` : null}
      ${colsList.map(col => {
        const fkDef = fksList.find(fk => fk.from_column_id === col.id) ?? null;
        return html`<${DataCell} key=${col.id} col=${col} row=${row} fkDef=${fkDef} />`;
      })}
      <td class="actions-td">
        <button
          class=${'btn-row-action' + (isActive ? ' active' : '')}
          onClick=${openHistoryForRow}
        >History</button>
        <button class="btn-row-action danger" onClick=${confirmDelete}>Delete</button>
      </td>
    </tr>
    ${isExpanded && markdownCols.map(mdCol => html`
      <${MarkdownExpander}
        key=${'expander-' + rowId + '-' + mdCol.id}
        row=${row}
        mdCol=${mdCol}
        colCount=${visibleCols.length}
      />
    `)}
  `;
}

// ---------------------------------------------------------------------------
// Component: DataTable
// ---------------------------------------------------------------------------
function DataTable() {
  const colsList = columns.value;
  const fksList = foreignKeys.value;
  const displayRows = sortedFilteredRows.value;
  const allRows = rows.value;
  const tid = activeTableId.value;
  const q = searchQuery.value;

  if (tid === null) {
    return html`<div id="no-table-state">
      <strong>No table selected</strong>
      <p>Create a table using the sidebar on the left.</p>
    </div>`;
  }

  if (colsList.length === 0) {
    return html`<div id="no-cols-hint">
      No columns defined yet. Click <strong>Manage Columns</strong> to add your first column.
    </div>`;
  }

  // Markdown columns are hidden from headers — they appear in the expander row
  const visibleCols = colsList.filter(c => (c.col_type || 'text') !== 'markdown');
  const hasMdCols   = colsList.some(c => (c.col_type || 'text') === 'markdown');

  return html`
    <div>
      <div class="filter-bar">
        <span class="filter-bar-label">Search:</span>
        <input
          type="text"
          placeholder="Filter rows…"
          value=${q}
          onInput=${(e) => { searchQuery.value = e.target.value; }}
        />
        ${q ? html`<button class="toolbar-btn" style="padding:4px 10px;font-size:12px"
          onClick=${() => { searchQuery.value = ''; }}>Clear</button>` : null}
        <span id="row-count">${allRows.length} row${allRows.length !== 1 ? 's' : ''}${q && displayRows.length !== allRows.length ? ` (${displayRows.length} shown)` : ''}</span>
      </div>

      ${displayRows.length === 0 && allRows.length === 0
        ? html`<div id="empty-state">
            <strong>No rows yet</strong>
            <p>Click <strong>+ Add Row</strong> to create your first entry.</p>
          </div>`
        : displayRows.length === 0
        ? html`<div id="empty-state">
            <strong>No matching rows</strong>
            <p>Try adjusting your search query.</p>
          </div>`
        : null
      }

      ${displayRows.length > 0 ? html`
        <table id="main-table">
          <thead>
            <tr>
              ${hasMdCols ? html`<th class="expand-chevron-th" title="Click row to expand notes"></th>` : null}
              ${visibleCols.map(col => {
                const fkDef = fksList.find(fk => fk.from_column_id === col.id) ?? null;
                return html`<${ColHeader} key=${col.id} col=${col} fkDef=${fkDef} />`;
              })}
              <th class="actions-th">Actions</th>
            </tr>
          </thead>
          <tbody>
            ${displayRows.map(row => html`
              <${DataRow} key=${row.row_id} row=${row} colsList=${colsList} fksList=${fksList} />
            `)}
          </tbody>
        </table>
      ` : null}
    </div>
  `;
}

// ---------------------------------------------------------------------------
// History panel data (kept as module state, not signal — avoids extra renders)
// ---------------------------------------------------------------------------
let _historyData = [];
const historyLoading = signal(false);
const historyError   = signal(null);
const historyRows    = signal([]);   // rendered entries

async function loadHistoryData(rowId) {
  historyLoading.value = true;
  historyError.value   = null;
  try {
    const history = await API.getHistory(rowId);
    historyRows.value = [...history].reverse();
  } catch (err) {
    historyError.value = err.message;
  } finally {
    historyLoading.value = false;
  }
}

// ---------------------------------------------------------------------------
// Component: HistoryPanel
// ---------------------------------------------------------------------------
function HistoryPanel() {
  const rowId = activeRowId.value;
  const loading = historyLoading.value;
  const error = historyError.value;
  const entries = historyRows.value;
  const fks = foreignKeys.value;
  const fkMap = fkOptionsMap.value;
  const cols = columns.value;

  if (!rowId) return null;

  const close = () => {
    activeRowId.value = null;
  };

  const resolveFkVal = (colName, val) => {
    const fkDef = fks.find(fk => fk.from_column_name === colName);
    if (!fkDef) return `"${val}"`;
    const opts = fkMap[fkDef.from_column_id] || [];
    const m = opts.find(o => o.row_id === val);
    return m
      ? `"${m.label ?? val.slice(0, 8) + '…'}"`
      : `"${val.slice(0, 8)}… (deleted)"`;
  };

  return html`
    <div id="history-panel" style="display:flex;flex-direction:column">
      <div id="history-header">
        <div>
          <h2>Row History</h2>
          <div id="history-row-label">${rowLabel(rowId)}</div>
        </div>
        <button id="btn-history-close" title="Close history" onClick=${close}>×</button>
      </div>
      <ol id="history-list">
        ${loading
          ? html`<li style="padding:8px 16px;color:#94a3b8;font-size:12px">Loading…</li>`
          : error
          ? html`<li style="padding:8px 16px;color:#dc2626;font-size:12px">${error}</li>`
          : entries.length === 0
          ? html`<li style="padding:8px 16px;color:#94a3b8;font-size:12px">No history found.</li>`
          : entries.map((entry, i) => {
              const ts = entry.timestamp.endsWith('Z') ? entry.timestamp : entry.timestamp + 'Z';
              const dateObj = new Date(ts);
              let descClass = 'history-desc';
              let descText = '';
              if (entry.sentinel === '__deleted__') {
                descClass += ' sentinel';
                descText = entry.value === '1' ? 'Row deleted' : 'Row restored';
              } else if (entry.sentinel === '__new__') {
                descClass += ' new-row';
                descText = 'Row created';
              } else {
                const col = entry.column_name || '(deleted column)';
                let displayVal;
                if (entry.value === null) {
                  displayVal = '(cleared)';
                } else {
                  displayVal = resolveFkVal(entry.column_name, entry.value);
                }
                descText = `${col} → ${displayVal}`;
              }
              return html`<li key=${i}>
                <span class="history-time" title=${relativeTime(dateObj)}>${dateObj.toLocaleString()}</span>
                <span class=${descClass}>${descText}</span>
              </li>`;
            })
        }
      </ol>
    </div>
  `;
}

// ---------------------------------------------------------------------------
// Component: ColManageModal
// ---------------------------------------------------------------------------
function ColManageModal({ onClose }) {
  const cols = columns.value;
  const [newName, setNewName]       = useState('');
  const [newType, setNewType]       = useState('text');
  const [newUnique, setNewUnique]   = useState(false);
  const [newChoices, setNewChoices] = useState('');
  const newNameRef = useRef(null);

  const TYPE_OPTIONS = [
    ['text','Text'],['number','Number'],['boolean','Checkbox'],
    ['date','Date'],['datetime','Date & Time'],['url','URL'],['select','Select'],['markdown','Markdown']
  ];

  const doAddColumn = async () => {
    const name = newName.trim();
    if (!name) return;
    const col_choices = newType === 'select'
      ? newChoices.split(',').map(s => s.trim()).filter(Boolean).join(',') || null
      : null;
    try {
      await API.addColumn(name, newUnique ? 1 : 0, newType, col_choices);
      setNewName(''); setNewType('text'); setNewUnique(false); setNewChoices('');
      await refresh();
      toast(`Column "${name}" added`, 'success');
      requestAnimationFrame(() => newNameRef.current?.focus());
    } catch (err) {
      toast(err.message);
    }
  };

  return html`
    <dialog open>
      <div class="modal-header">
        <h3>Manage Columns</h3>
        <button class="modal-close" onClick=${onClose}>×</button>
      </div>
      <div class="modal-body">
        <ul id="col-list">
          ${cols.length === 0
            ? html`<li style="padding:12px 0;color:#94a3b8;font-size:13px;border:none">No columns yet. Add one below.</li>`
            : cols.map(col => html`<${ColItem} key=${col.id} col=${col} />`)
          }
        </ul>
        <div class="add-col-row">
          <input
            ref=${newNameRef}
            type="text"
            placeholder="New column name…"
            value=${newName}
            onInput=${(e) => setNewName(e.target.value)}
            onKeyDown=${(e) => { if (e.key === 'Enter') { e.preventDefault(); doAddColumn(); } }}
          />
          <select class="add-col-type" value=${newType} onChange=${(e) => setNewType(e.target.value)}>
            ${TYPE_OPTIONS.map(([v, l]) => html`<option key=${v} value=${v}>${l}</option>`)}
          </select>
          <label class="add-unique-label">
            <input type="checkbox" checked=${newUnique} onChange=${(e) => setNewUnique(e.target.checked)} /> Unique
          </label>
          <button onClick=${doAddColumn}>Add</button>
        </div>
        ${newType === 'select' ? html`
          <div class="col-choices-row" style="margin-top:4px">
            <span style="font-size:12px;color:#64748b;white-space:nowrap">Choices (comma-separated):</span>
            <input
              class="col-choices-input"
              type="text"
              placeholder="e.g. Draft, Active, Closed"
              value=${newChoices}
              onInput=${(e) => setNewChoices(e.target.value)}
            />
          </div>
        ` : null}
      </div>
    </dialog>
  `;
}

function ColItem({ col }) {
  const [name, setName]       = useState(col.name);
  const [colType, setColType] = useState(col.col_type || 'text');
  const [choices, setChoices] = useState(col.col_choices || '');

  const TYPE_OPTIONS = [
    ['text','Text'],['number','Number'],['boolean','Checkbox'],
    ['date','Date'],['datetime','Date & Time'],['url','URL'],['select','Select'],['markdown','Markdown']
  ];

  const doRename = async () => {
    const newName = name.trim();
    if (!newName || newName === col.name) return;
    try {
      await API.renameColumn(col.id, newName);
      await refresh();
      toast(`Renamed to "${newName}"`, 'success');
      if (activeRowId.value) await loadHistoryData(activeRowId.value);
    } catch (err) {
      toast(err.message);
    }
  };

  const doSetUnique = async (e) => {
    const newVal = e.target.checked ? 1 : 0;
    try {
      await API.setColumnUnique(col.id, newVal);
      await refresh();
      toast(`Unique constraint ${newVal ? 'enabled' : 'disabled'} on "${col.name}"`, 'success');
    } catch (err) {
      e.target.checked = !e.target.checked;
      toast(err.message);
    }
  };

  const doSetType = async () => {
    const newChoices = colType === 'select'
      ? choices.split(',').map(s => s.trim()).filter(Boolean).join(',') || null
      : null;
    try {
      await API.setColumnType(col.id, colType, newChoices);
      await refresh();
      toast(`Column type set to "${colType}"`, 'success');
    } catch (err) {
      toast(err.message);
    }
  };

  const doDelete = async () => {
    const ok = await showConfirm(
      'Remove Column',
      `Remove column "${col.name}"? Existing cell data is preserved in history but will no longer appear in the table.`,
      'Remove', true
    );
    if (!ok) return;
    try {
      await API.deleteColumn(col.id);
      await refresh();
      toast(`Column "${col.name}" removed`, 'success');
    } catch (err) {
      toast(err.message);
    }
  };

  return html`
    <li>
      <input
        type="text"
        class="col-name-input"
        value=${name}
        onInput=${(e) => setName(e.target.value)}
        onKeyDown=${(e) => { if (e.key === 'Enter') { e.preventDefault(); doRename(); } }}
      />
      <button class="col-action-btn" onClick=${doRename}>Rename</button>
      <label class="unique-label">
        <input type="checkbox" checked=${col.is_unique === 1} onChange=${doSetUnique} /> Unique
      </label>
      <select class="col-type-select" value=${colType} onChange=${(e) => setColType(e.target.value)}>
        ${TYPE_OPTIONS.map(([v, l]) => html`<option key=${v} value=${v}>${l}</option>`)}
      </select>
      ${colType === 'select' ? html`
        <input
          class="col-choices-input"
          style="min-width:140px"
          type="text"
          placeholder="e.g. Draft, Active, Closed"
          value=${choices}
          onInput=${(e) => setChoices(e.target.value)}
        />
      ` : null}
      <button class="col-action-btn" onClick=${doSetType}>Set</button>
      <button class="col-action-btn danger" onClick=${doDelete}>Remove</button>
    </li>
  `;
}

// ---------------------------------------------------------------------------
// Component: RelationshipsModal
// ---------------------------------------------------------------------------
function RelationshipsModal({ onClose }) {
  const fks = foreignKeys.value;
  const cols = columns.value;
  const tbls = tables.value;
  const tid = activeTableId.value;
  const [fromColId, setFromColId] = useState('');
  const [toTableId, setToTableId] = useState('');

  const existingFkColIds = new Set(fks.map(fk => fk.from_column_id));
  const availableCols = cols.filter(c => !existingFkColIds.has(c.id));
  const otherTables = tbls.filter(t => t.id !== tid);

  const doAdd = async () => {
    if (!fromColId || !toTableId) { toast('Select both a column and a target table'); return; }
    try {
      await API.addForeignKey(parseInt(fromColId), parseInt(toTableId));
      await refresh();
      setFromColId(''); setToTableId('');
      toast('Relationship added', 'success');
    } catch (err) {
      toast(err.message);
    }
  };

  const doDelete = async (fkId) => {
    try {
      await API.deleteForeignKey(fkId);
      await refresh();
      toast('Relationship removed', 'success');
    } catch (err) {
      toast(err.message);
    }
  };

  return html`
    <dialog open>
      <div class="modal-header">
        <h3>Relationships</h3>
        <button class="modal-close" onClick=${onClose}>×</button>
      </div>
      <div class="modal-body">
        <p style="font-size:12px;color:#64748b;margin-bottom:14px">
          Foreign key columns store the row UUID of the referenced table's row.
          Editing a FK cell shows a dropdown of available rows.
        </p>
        <ul id="fk-list">
          ${fks.length === 0
            ? html`<li style="color:#94a3b8;font-size:13px;padding:8px 0">No relationships defined.</li>`
            : fks.map(fk => html`
              <li key=${fk.id}>
                <span class="fk-desc">${fk.from_column_name}</span>
                <span class="fk-arrow">→</span>
                <span style="color:#8b5cf6;font-weight:600">${fk.to_table_name}</span>
                <button class="col-action-btn danger" onClick=${() => doDelete(fk.id)}>Remove</button>
              </li>
            `)
          }
        </ul>
        <div class="add-fk-form">
          <label>Column in this table</label>
          <select value=${fromColId} onChange=${(e) => setFromColId(e.target.value)}>
            <option value="">— select column —</option>
            ${availableCols.map(c => html`<option key=${c.id} value=${c.id}>${c.name}</option>`)}
          </select>
          <label>References table</label>
          <select value=${toTableId} onChange=${(e) => setToTableId(e.target.value)}>
            <option value="">— select table —</option>
            ${otherTables.map(t => html`<option key=${t.id} value=${t.id}>${t.name}</option>`)}
          </select>
          <button onClick=${doAdd}>Add Relationship</button>
        </div>
      </div>
    </dialog>
  `;
}

// ---------------------------------------------------------------------------
// Component: ConfirmDeleteRowModal
// ---------------------------------------------------------------------------
function ConfirmDeleteRowModal({ rowId, onClose }) {
  const doDelete = async () => {
    onClose();
    try {
      await API.deleteRow(rowId);
      if (activeRowId.value === rowId) activeRowId.value = null;
      await refresh();
      toast('Row deleted', 'success');
    } catch (err) {
      toast(err.message);
    }
  };

  return html`
    <dialog open>
      <div class="modal-header">
        <h3>Delete Row</h3>
        <button class="modal-close" onClick=${onClose}>×</button>
      </div>
      <div class="modal-body" style="text-align:center;padding:24px 20px">
        <p style="color:#475569;margin-bottom:4px">Are you sure you want to delete this row?</p>
        <p class="row-id-hint" style="font-family:monospace;font-size:11px;color:#94a3b8">${rowId}</p>
        <p style="font-size:12px;color:#94a3b8;margin-top:8px">The row will be soft-deleted. All history is preserved.</p>
        <div class="confirm-actions">
          <button class="btn-confirm-cancel" onClick=${onClose}>Cancel</button>
          <button class="btn-confirm-delete" onClick=${doDelete}>Delete</button>
        </div>
      </div>
    </dialog>
  `;
}

// ---------------------------------------------------------------------------
// Component: PromptModal
// ---------------------------------------------------------------------------
function PromptModal({ title, label, defaultValue, resolve, onClose }) {
  const inputRef = useRef(null);

  useEffect(() => {
    const el = inputRef.current;
    if (el) { el.focus(); el.select(); }
  }, []);

  const submit = () => {
    const val = inputRef.current?.value.trim() || null;
    onClose();
    resolve(val);
  };
  const cancel = () => { onClose(); resolve(null); };

  return html`
    <dialog open>
      <div class="modal-header">
        <h3>${title}</h3>
        <button class="modal-close" onClick=${cancel}>×</button>
      </div>
      <div class="modal-body" style="padding:20px">
        <label style="display:block;font-size:13px;color:#475569;margin-bottom:6px">${label}</label>
        <input
          ref=${inputRef}
          type="text"
          style="width:100%;padding:7px 10px;border:1px solid #e2e8f0;border-radius:4px;font-size:14px"
          defaultValue=${defaultValue}
          onKeyDown=${(e) => {
            if (e.key === 'Enter') { e.preventDefault(); submit(); }
            if (e.key === 'Escape') { e.preventDefault(); cancel(); }
          }}
        />
        <div class="prompt-actions" style="display:flex;gap:8px;justify-content:flex-end;margin-top:14px">
          <button class="btn-prompt-cancel" onClick=${cancel}>Cancel</button>
          <button class="btn-prompt-ok" onClick=${submit}>OK</button>
        </div>
      </div>
    </dialog>
  `;
}

// ---------------------------------------------------------------------------
// Component: GeneralConfirmModal
// ---------------------------------------------------------------------------
function GeneralConfirmModal({ title, message, confirmLabel, danger, resolve, onClose }) {
  const confirm = () => { onClose(); resolve(true); };
  const cancel  = () => { onClose(); resolve(false); };

  return html`
    <dialog open>
      <div class="modal-header">
        <h3>${title}</h3>
        <button class="modal-close" onClick=${cancel}>×</button>
      </div>
      <div class="modal-body" style="padding:20px">
        <p style="color:#475569;font-size:14px">${message}</p>
        <div class="confirm-actions">
          <button class="btn-confirm-cancel" onClick=${cancel}>Cancel</button>
          <button
            class="btn-confirm-delete"
            style=${danger ? '' : 'background:#3b82f6;border-color:#2563eb'}
            onClick=${confirm}
          >${confirmLabel}</button>
        </div>
      </div>
    </dialog>
  `;
}

// ---------------------------------------------------------------------------
// Component: ModalLayer — renders whichever modal is active
// ---------------------------------------------------------------------------
function ModalLayer() {
  const ms = modalState.value;
  if (!ms) return null;

  const onClose = () => { modalState.value = null; };

  if (ms.type === 'cols')    return html`<${ColManageModal} onClose=${onClose} />`;
  if (ms.type === 'rels')    return html`<${RelationshipsModal} onClose=${onClose} />`;
  if (ms.type === 'confirm') return html`<${ConfirmDeleteRowModal} rowId=${ms.rowId} onClose=${onClose} />`;
  if (ms.type === 'prompt')  return html`<${PromptModal} ...${{...ms, onClose}} />`;
  if (ms.type === 'general-confirm') return html`<${GeneralConfirmModal} ...${{...ms, onClose}} />`;
  return null;
}

// ---------------------------------------------------------------------------
// Component: Toolbar
// ---------------------------------------------------------------------------
function Toolbar() {
  const tbl = activeTable.value;
  const disabled = !tbl;
  const cols = columns.value;

  const handleAddRow = async () => {
    if (disabled) return;
    try {
      await API.addRow({});
      await refresh();
      toast('Row added', 'success');
      // Auto-focus first editable cell of last row
      requestAnimationFrame(() => {
        const tbody = document.querySelector('#main-table tbody');
        if (!tbody) return;
        const lastTr = tbody.querySelector('tr:last-child');
        if (!lastTr) return;
        const firstCell = lastTr.querySelector('td.cell-editable, td.cell-fk');
        if (firstCell) firstCell.click();
      });
    } catch (err) {
      toast(err.message);
    }
  };

  return html`
    <div id="toolbar">
      <span id="toolbar-title">
        ${tbl ? `logpad — ${tbl.name}` : 'logpad'}
      </span>
      <button
        class="toolbar-btn primary"
        disabled=${disabled}
        onClick=${handleAddRow}
      >+ Add Row</button>
      <button
        class="toolbar-btn"
        disabled=${disabled}
        onClick=${() => { if (!disabled) modalState.value = { type: 'cols' }; }}
      >Manage Columns</button>
      <button
        class="toolbar-btn"
        disabled=${disabled}
        onClick=${() => { if (!disabled) modalState.value = { type: 'rels' }; }}
      >Relationships</button>
    </div>
  `;
}

// ---------------------------------------------------------------------------
// Component: App (root)
// ---------------------------------------------------------------------------
function App() {
  const ready = workerReady.value;
  const err = loadError.value;
  const rowId = activeRowId.value;

  if (!ready || err) {
    return html`
      <div style="position:fixed;inset:0;background:#1e293b;color:#94a3b8;display:flex;align-items:center;justify-content:center;font-size:18px;z-index:99999">
        ${err ?? 'Loading database…'}
      </div>
    `;
  }

  return html`
    <${Toolbar} />
    <div id="app-body">
      <${Sidebar} />
      <div id="layout">
        <div id="table-panel">
          <${DataTable} />
        </div>
        ${rowId ? html`<${HistoryPanel} />` : null}
      </div>
    </div>
    <${ModalLayer} />
  `;
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
render(html`<${App} />`, document.getElementById('app'));
