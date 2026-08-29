(() => {
  'use strict';

  const $ = id => document.getElementById(id);
  let datasetId = '…';

  function escapeHtml(value) {
    return String(value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  function showError(message) {
    $('results').insertAdjacentHTML('beforeend', `<div class="error">${escapeHtml(message)}</div>`);
  }

  function setBar(name, percent, text) {
    $(`${name}Bar`).style.width = `${Math.max(0, Math.min(100, Number(percent) || 0))}%`;
    if (text) $(`${name}Text`).textContent = text;
  }

  function indeterminate(name, text) {
    $(`${name}Bar`).classList.add('indeterminate');
    setBar(name, 100, text);
  }

  function finishBar(name, text = 'Done', color = '#28a745') {
    const bar = $(`${name}Bar`);
    bar.classList.remove('indeterminate');
    bar.style.background = color;
    setBar(name, 100, text);
  }

  function resetProgress() {
    $('results').innerHTML = '';
    $('chunks').innerHTML = '';
    ['upload', 'packing', 'splitting'].forEach(name => {
      const bar = $(`${name}Bar`);
      bar.className = 'bar';
      bar.style.width = '0%';
      bar.style.background = '#0090ff';
    });
    $('uploadText').textContent = '0%';
    $('packingText').textContent = 'Waiting...';
    $('splittingText').textContent = 'Waiting...';
  }

  async function loadConfig() {
    try {
      const response = await fetch('/api/config', { cache: 'no-store' });
      if (!response.ok) throw new Error(await response.text());
      const data = await response.json();
      datasetId = data.datasetId;
      document.querySelectorAll('.dataset-label').forEach(node => { node.textContent = datasetId; });
      $('datasetLabel').textContent = datasetId;
    } catch (error) {
      console.error('Could not load configuration:', error);
    }
  }

  function toggleMode() {
    const input = $('fileInput');
    const folder = document.querySelector('input[name="mode"]:checked').value === 'folder';
    if (folder) {
      input.setAttribute('webkitdirectory', '');
      input.setAttribute('multiple', '');
    } else {
      input.removeAttribute('webkitdirectory');
      input.removeAttribute('multiple');
    }
    input.value = '';
  }

  function startProcess() {
    const input = $('fileInput');
    if (!input.files.length) {
      alert('Please select a file or folder.');
      return;
    }

    const button = $('uploadBtn');
    button.disabled = true;
    resetProgress();
    $('progress').classList.remove('hidden');
    $('historyCard').classList.add('hidden');
    $('paymentsCard').classList.add('hidden');

    const data = new FormData();
    for (const file of input.files) {
      data.append('files', file);
      data.append('paths', file.webkitRelativePath || file.name);
    }

    const xhr = new XMLHttpRequest();
    xhr.upload.onprogress = event => {
      if (event.lengthComputable) {
        const percent = Math.round(event.loaded / event.total * 100);
        setBar('upload', percent, `${percent}%`);
      }
    };
    xhr.onerror = () => { showError('Could not reach the server.'); button.disabled = false; };
    xhr.onload = () => {
      if (xhr.status !== 200) {
        showError(xhr.responseText || `Upload failed with HTTP ${xhr.status}.`);
        button.disabled = false;
        return;
      }
      try {
        const result = JSON.parse(xhr.responseText);
        setBar('upload', 100, 'Done');
        $('uploadBar').style.background = '#28a745';
        listenToJob(result.jobId);
      } catch (error) {
        showError(`Invalid server response: ${error.message}`);
        button.disabled = false;
      }
    };
    xhr.open('POST', '/upload-target');
    xhr.send(data);
  }

  function listenToJob(jobId) {
    const source = new EventSource(`/status/${encodeURIComponent(jobId)}`);
    const button = $('uploadBtn');

    source.addEventListener('packing', event => {
      if (event.data === 'start') indeterminate('packing', 'Processing...');
      if (event.data === 'done') finishBar('packing');
    });
    source.addEventListener('rootcid', event => {
      $('results').insertAdjacentHTML('beforeend', `<div class="success"><strong>IPFS Root CID</strong><br><span class="cid">${escapeHtml(event.data)}</span></div>`);
    });
    source.addEventListener('splitting', event => {
      if (event.data === 'start') indeterminate('splitting', 'Calculating optimal chunk sizes...');
      else if (event.data === 'done') finishBar('splitting');
      else if (event.data.startsWith('skipped')) finishBar('splitting', event.data, '#6c757d');
    });
    source.addEventListener('chunkinit', event => {
      const count = Number.parseInt(event.data, 10);
      $('chunks').innerHTML = '';
      for (let index = 0; index < count; index += 1) {
        $('chunks').insertAdjacentHTML('beforeend', `<div class="step"><div class="label"><span>4. Importing Chunk ${index + 1}</span><span id="chunkText${index}">0%</span></div><div class="track"><div id="chunkBar${index}" class="bar"></div></div></div>`);
      }
    });
    source.addEventListener('chunkprogress', event => {
      const data = JSON.parse(event.data);
      const bar = $(`chunkBar${data.index}`);
      const text = $(`chunkText${data.index}`);
      if (bar && text) { bar.style.width = `${data.pct}%`; text.textContent = `${data.pct}%`; }
    });
    source.addEventListener('chunkdone', event => {
      const data = JSON.parse(event.data);
      $('results').insertAdjacentHTML('beforeend', `<div class="success">Chunk ${Number(data.index) + 1} PieceCID: <span class="cid">${escapeHtml(data.cid)}</span></div>`);
    });
    source.addEventListener('pipelineerror', event => {
      const data = JSON.parse(event.data);
      showError(data.message);
    });
    source.addEventListener('done', event => {
      $('results').insertAdjacentHTML('beforeend', event.data === 'success' ? `<div class="success"><strong>All data secured on Filecoin Dataset ${escapeHtml(datasetId)}.</strong></div>` : '<div class="error">Upload failed.</div>');
      button.disabled = false;
      source.close();
    });
  }

  async function loadPayments() {
    $('historyCard').classList.add('hidden');
    $('paymentsCard').classList.remove('hidden');
    $('paymentsContent').textContent = 'Executing filecoin-pin payments status...';
    try {
      const response = await fetch('/api/payments');
      const data = await response.json();
      $('paymentsContent').textContent = response.ok ? data.output : `Error: ${data.error}`;
    } catch (error) { $('paymentsContent').textContent = `Network error: ${error.message}`; }
  }

  async function deleteGroup(pieceCids, button) {
    if (!confirm(`Remove ${pieceCids.length} piece(s) from Dataset ${datasetId}? This sends on-chain transactions and waits for confirmation.`)) return;
    button.disabled = true;
    button.textContent = 'Deleting...';
    try {
      const response = await fetch('/api/delete', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pieceCids }) });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Deletion failed.');
      alert(data.message);
      loadHistory();
    } catch (error) { alert(error.message); }
    finally { button.disabled = false; button.textContent = 'Delete File'; }
  }

  async function copyText(value, button) {
    try {
      await navigator.clipboard.writeText(value);
      const original = button.textContent;
      button.textContent = 'Copied!';
      setTimeout(() => { button.textContent = original; }, 1500);
    } catch { alert('Copy failed.'); }
  }

  async function loadHistory() {
    $('paymentsCard').classList.add('hidden');
    $('historyCard').classList.remove('hidden');
    $('historyContent').textContent = 'Querying Filecoin blockchain...';
    try {
      const response = await fetch('/api/history');
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Could not load history.');
      if (!data.pieces?.length) { $('historyContent').textContent = 'No pieces found in this dataset yet.'; return; }

      const groups = [];
      let current = null;
      for (const piece of data.pieces) {
        const hasRoot = piece.rootcid && piece.rootcid !== 'Unknown';
        if (current && hasRoot && current.rootcid === piece.rootcid) current.pieces.push(piece);
        else { current = { rootcid: piece.rootcid, originalfile: piece.originalfile, hasRoot, pieces: [piece] }; groups.push(current); }
      }

      const table = document.createElement('table');
      table.innerHTML = '<tr><th>Original File</th><th>Root CID</th><th>Piece CID</th><th>Size</th><th>Action</th></tr>';
      for (const group of groups) {
        group.pieces.forEach((piece, index) => {
          const row = table.insertRow();
          if (index === 0) {
            const fileCell = row.insertCell(); fileCell.rowSpan = group.pieces.length; fileCell.textContent = group.originalfile || 'Unnamed Legacy Upload';
            const rootCell = row.insertCell(); rootCell.rowSpan = group.pieces.length; rootCell.className = 'cid'; rootCell.textContent = group.hasRoot ? group.rootcid : 'N/A';
          }
          const pieceCell = row.insertCell(); pieceCell.className = 'cid';
          const pieceSpan = document.createElement('span'); pieceSpan.textContent = piece.pieceCid;
          const copyButton = document.createElement('button'); copyButton.className = 'copy'; copyButton.type = 'button'; copyButton.textContent = 'Copy'; copyButton.onclick = () => copyText(piece.pieceCid, copyButton);
          pieceCell.append(pieceSpan, copyButton);
          const sizeCell = row.insertCell(); sizeCell.textContent = piece.size || 'N/A';
          if (index === 0) {
            const actionCell = row.insertCell(); actionCell.rowSpan = group.pieces.length;
            const deleteButton = document.createElement('button'); deleteButton.className = 'red'; deleteButton.type = 'button'; deleteButton.textContent = 'Delete File'; deleteButton.onclick = () => deleteGroup(group.pieces.map(item => item.pieceCid), deleteButton);
            actionCell.appendChild(deleteButton);
          }
        });
      }
      $('historyContent').replaceChildren(table);
    } catch (error) { $('historyContent').innerHTML = `<div class="error">${escapeHtml(error.message)}</div>`; }
  }

  document.querySelectorAll('input[name="mode"]').forEach(input => input.addEventListener('change', toggleMode));
  $('uploadBtn').addEventListener('click', startProcess);
  $('historyBtn').addEventListener('click', loadHistory);
  $('paymentsBtn').addEventListener('click', loadPayments);
  loadConfig();
})();
