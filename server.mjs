import express from 'express';
import multer from 'multer';
import fs from 'fs';
import path from 'path';
import { exec } from 'child_process';
import { promisify } from 'util';
import { Readable } from 'stream';

// Synapse SDK & Viem Imports
import { Synapse } from '@filoz/synapse-sdk';
import * as PDPVerifier from '@filoz/synapse-core/pdp-verifier';
import { mainnet } from '@filoz/synapse-core/chains'; 
import { privateKeyToAccount } from 'viem/accounts';
import { createPublicClient, http } from 'viem';

const execPromise = promisify(exec);
const app = express();
const port = 3000;

// Enable JSON body parsing for the delete endpoint
app.use(express.json());

// Setup directories and limits (5GB limit)
const uploadDir = path.resolve('uploads');
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir);

const upload = multer({ 
    dest: 'uploads/',
    limits: { fileSize: 5 * 1024 * 1024 * 1024 } 
});

// Configure your Filecoin wallet & Dataset
const PRIVATE_KEY = '0x_YOUR_PRIVATE_KEY_HERE';
const DATASET_ID = 99; // The dataset we are uploading to and reading from
const RPC_URL = 'https://api.node.glif.io/rpc/v1';

// Maximum size for a single Filecoin deal via Synapse (~1 GiB)
const MAX_CAR_SIZE = 1065353216;

// Viem Public Client for reading from the blockchain
const publicClient = createPublicClient({
    chain: mainnet,
    transport: http(RPC_URL)
});

// In-memory store to track background jobs
const activeJobs = new Map();

// --- 1. FRONTEND UI ---
app.get('/', (req, res) => {
    // CACHE BUSTER: Forces the browser to load the newest HTML every time
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
    
    res.send(`
        <!DOCTYPE html>
        <html>
        <head>
            <title>Filecoin Auto-Split Uploader (v4)</title>
            <style>
                body { font-family: system-ui, sans-serif; background: #f4f7f6; padding: 2rem; display: flex; justify-content: center; }
                .container { width: 100%; max-width: 1400px; } 
                .card { background: white; padding: 2rem; border-radius: 12px; box-shadow: 0 4px 12px rgba(0,0,0,0.1); margin-bottom: 20px; }
                .progress-container { margin-top: 15px; display: none; }
                .step { margin-bottom: 15px; }
                .step-label { font-weight: bold; margin-bottom: 5px; font-size: 14px; color: #333; display: flex; justify-content: space-between; }
                .bar-bg { width: 100%; background: #e0e0e0; height: 12px; border-radius: 6px; overflow: hidden; }
                .bar-fill { height: 100%; background: #0090ff; width: 0%; transition: width 0.2s ease; }
                .indeterminate { background: repeating-linear-gradient(45deg, #0090ff, #0090ff 10px, #4facfe 10px, #4facfe 20px); background-size: 200% 200%; animation: stripes 2s linear infinite; }
                @keyframes stripes { 100% { background-position: -100% 0; } }
                
                .radio-group { margin-bottom: 15px; font-size: 15px; }
                .radio-group label { margin-right: 15px; cursor: pointer; }
                
                .button-stack { display: flex; flex-direction: column; gap: 10px; margin-top: 15px; margin-bottom: 15px; }
                .button-stack button { color: white; border: none; padding: 12px 20px; border-radius: 6px; cursor: pointer; font-size: 16px; width: 100%; font-weight: bold; }
                button:disabled { background: #ccc !important; cursor: not-allowed; }
                
                /* History & Payments Table Styles */
                .table-wrapper { overflow-x: auto; margin-top: 15px; border-radius: 6px; }
                table { width: 100%; border-collapse: collapse; font-size: 13px; }
                th, td { border: 1px solid #ddd; padding: 10px; text-align: left; }
                th { background-color: #f8f9fa; white-space: nowrap; }
                .hidden-card { display: none; }
                
                .filename-cell { white-space: normal; word-break: break-word; min-width: 250px; }
                .cid-cell { font-family: monospace; color: #444; }
                .grouped-cell { vertical-align: middle; background-color: #fdfdfd; }
                .delete-btn { background: #dc3545 !important; padding: 5px 10px; width: auto; font-size: 12px; margin: 0; min-width: auto; font-weight: normal !important; }
                .delete-btn:hover { background: #c82333 !important; }
                
                /* New CID Container & Copy Button Styles */
                .cid-container { display: flex; justify-content: space-between; align-items: center; gap: 8px; min-width: 180px; }
                .copy-btn { background: #e9ecef !important; border: 1px solid #ced4da !important; padding: 3px 8px !important; border-radius: 4px; cursor: pointer; font-size: 11px !important; color: #495057 !important; transition: 0.2s; width: auto !important; font-weight: normal !important; }
                .copy-btn:hover { background: #ced4da !important; }
                
                .terminal-output { background: #212529; color: #f8f9fa; padding: 15px; border-radius: 6px; overflow-x: auto; font-family: monospace; font-size: 14px; white-space: pre-wrap; line-height: 1.5; }
            </style>
        </head>
        <body>
            <div class="container">
                <!-- UPLOAD CARD -->
                <div class="card">
                    <h2>Upload to Filecoin (v4)</h2>
                    <p style="font-size: 14px; color: #666;">Upload a file or folder. It will be packed, split (optimized for padding), and pinned to Dataset ${DATASET_ID}.</p>
                    
                    <div class="radio-group">
                        <label><input type="radio" name="uploadType" value="file" checked onchange="toggleMode('file')"> Single File</label>
                        <label><input type="radio" name="uploadType" value="folder" onchange="toggleMode('folder')"> Folder Directory</label>
                    </div>

                    <input type="file" id="fileInput" style="margin-bottom: 15px; width: 100%; border: 1px solid #ccc; padding: 10px; border-radius: 6px;" />
                    
                    <div class="button-stack">
                        <button id="uploadBtn" onclick="startProcess()" style="background: #28a745;">1. Process & Upload File</button>
                        <button class="secondary" onclick="loadHistory()" style="background: #0090ff;">2. View Upload History (Dataset ${DATASET_ID})</button>
                        <button class="info" onclick="loadPayments()" style="background: #17a2b8;">3. Check Payments Status</button>
                    </div>

                    <div id="ui-progress" class="progress-container">
                        <div class="step">
                            <div class="step-label"><span>1. Uploading to Server</span><span id="lbl-upload">0%</span></div>
                            <div class="bar-bg"><div id="bar-upload" class="bar-fill"></div></div>
                        </div>
                        <div class="step">
                            <div class="step-label"><span>2. Packing to .CAR</span><span id="lbl-packing">Waiting...</span></div>
                            <div class="bar-bg"><div id="bar-packing" class="bar-fill"></div></div>
                        </div>
                        <div class="step">
                            <div class="step-label"><span>3. Carbites Splitting (>1GB)</span><span id="lbl-splitting">Waiting...</span></div>
                            <div class="bar-bg"><div id="bar-splitting" class="bar-fill"></div></div>
                        </div>
                        <div id="final-results" style="margin-top: 20px; font-size: 14px; color: #333;"></div>
                        <div id="filecoin-chunks" style="margin-top: 20px;"></div>
                    </div>
                </div>
                
                <!-- PAYMENTS CARD -->
                <div id="paymentsCard" class="card hidden-card">
                    <h2>Payments Status</h2>
                    <div id="paymentsContent" class="terminal-output">Loading blockchain data...</div>
                </div>

                <!-- HISTORY CARD -->
                <div id="historyCard" class="card hidden-card">
                    <h2>Upload History (Dataset ${DATASET_ID})</h2>
                    <div id="historyContent">Loading blockchain data...</div>
                </div>
            </div>

            <script>
                // --- Upload UI Logic ---
                function toggleMode(mode) {
                    const input = document.getElementById('fileInput');
                    if (mode === 'folder') {
                        input.setAttribute('webkitdirectory', '');
                        input.setAttribute('multiple', '');
                    } else {
                        input.removeAttribute('webkitdirectory');
                        input.removeAttribute('multiple');
                    }
                    input.value = ''; 
                }

                function updateBar(id, percent, text) {
                    document.getElementById('bar-' + id).style.width = percent + '%';
                    if(text) document.getElementById('lbl-' + id).innerText = text;
                }

                function setIndeterminate(id, text) {
                    const bar = document.getElementById('bar-' + id);
                    bar.style.width = '100%';
                    bar.classList.add('indeterminate');
                    document.getElementById('lbl-' + id).innerText = text;
                }

                function finishIndeterminate(id, customText = 'Done', color = '#28a745') {
                    const bar = document.getElementById('bar-' + id);
                    bar.classList.remove('indeterminate');
                    bar.style.width = '100%';
                    bar.style.background = color; 
                    document.getElementById('lbl-' + id).innerText = customText;
                }

                function startProcess() {
                    const fileInput = document.getElementById('fileInput');
                    if (!fileInput.files.length) return alert('Please select a file or folder.');
                    
                    document.getElementById('uploadBtn').disabled = true;
                    document.getElementById('ui-progress').style.display = 'block';
                    document.getElementById('historyCard').style.display = 'none';
                    document.getElementById('paymentsCard').style.display = 'none';

                    const formData = new FormData();
                    
                    for (let i = 0; i < fileInput.files.length; i++) {
                        const file = fileInput.files[i];
                        const path = file.webkitRelativePath || file.name;
                        formData.append('files', file);
                        formData.append('paths', path);
                    }

                    const xhr = new XMLHttpRequest();
                    xhr.upload.onprogress = (e) => {
                        if (e.lengthComputable) {
                            const pct = Math.round((e.loaded / e.total) * 100);
                            updateBar('upload', pct, pct + '%');
                        }
                    };

                    xhr.onload = () => {
                        if (xhr.status === 200) {
                            updateBar('upload', 100, 'Done');
                            document.getElementById('bar-upload').style.background = '#28a745';
                            const { jobId } = JSON.parse(xhr.responseText);
                            listenToJobs(jobId);
                        } else {
                            alert('Server upload failed: ' + xhr.responseText);
                        }
                    };

                    xhr.open('POST', '/upload-target');
                    xhr.send(formData);
                }

                function listenToJobs(jobId) {
                    const source = new EventSource('/status/' + jobId);

                    source.addEventListener('packing', (e) => {
                        if(e.data === 'start') setIndeterminate('packing', 'Processing...');
                        if(e.data === 'done') finishIndeterminate('packing');
                    });

                    source.addEventListener('root_cid', (e) => {
                        document.getElementById('final-results').innerHTML += \`
                            <div style="margin-bottom: 15px; padding: 10px; background: #e8f5e9; border-left: 4px solid #28a745; color: #333;">
                                <strong>IPFS Root CID:</strong><br>
                                <span style="font-family: monospace;">\${e.data}</span>
                            </div>\`;
                    });

                    source.addEventListener('splitting', (e) => {
                        if(e.data === 'start') setIndeterminate('splitting', 'Calculating optimal sizes...');
                        if(e.data === 'skipped') finishIndeterminate('splitting', 'Skipped (< 1GB)', '#6c757d');
                        if(e.data === 'done') finishIndeterminate('splitting');
                    });

                    source.addEventListener('chunk_init', (e) => {
                        const count = parseInt(e.data);
                        const container = document.getElementById('filecoin-chunks');
                        for(let i=0; i<count; i++) {
                            container.innerHTML += \`
                                <div class="step">
                                    <div class="step-label"><span>4. Uploading Chunk \${i+1}</span><span id="lbl-chunk-\${i}">0%</span></div>
                                    <div class="bar-bg"><div id="bar-chunk-\${i}" class="bar-fill"></div></div>
                                </div>
                            \`;
                        }
                    });

                    source.addEventListener('chunk_progress', (e) => {
                        const data = JSON.parse(e.data);
                        updateBar('chunk-' + data.index, data.pct, data.pct + '%');
                        if (data.pct === 100) document.getElementById('bar-chunk-' + data.index).style.background = '#28a745';
                    });

                    source.addEventListener('chunk_done', (e) => {
                        const data = JSON.parse(e.data);
                        document.getElementById('final-results').innerHTML += \`<div style="margin-bottom: 5px; font-weight: bold; color: green;">✅ Chunk \${data.index + 1} PieceCID: <span style="font-weight: normal; font-family: monospace;">\${data.cid}</span></div>\`;
                    });

                    source.addEventListener('done', () => {
                        document.getElementById('final-results').innerHTML += '<br><b style="font-size:16px; color: green;">All data secured on Filecoin Dataset ' + ${DATASET_ID} + '!</b>';
                        source.close();
                    });
                }
                
                // --- Payments Logic ---
                async function loadPayments() {
                    document.getElementById('historyCard').style.display = 'none';
                    document.getElementById('paymentsCard').style.display = 'block';
                    document.getElementById('paymentsContent').innerText = 'Executing: npx filecoin-pin payments status...\\nQuerying Filecoin Blockchain...';
                    
                    try {
                        const response = await fetch('/api/payments');
                        const data = await response.json();

                        if (response.ok) {
                            document.getElementById('paymentsContent').innerText = data.output;
                        } else {
                            document.getElementById('paymentsContent').innerText = 'Error: ' + data.error;
                        }
                    } catch (err) {
                        document.getElementById('paymentsContent').innerText = 'Network error: ' + err.message;
                    }
                }

                // --- Group Delete Logic ---
                async function deleteGroup(pieceCids, btnId) {
                    if (!confirm("Are you sure you want to remove this file (" + pieceCids.length + " chunk(s)) from Dataset ${DATASET_ID}? \\n\\nNote: This executes on-chain transactions and will take time to confirm.")) return;
                    
                    try {
                        const btn = document.getElementById(btnId);
                        if (btn) {
                            btn.innerText = "Deleting...";
                            btn.disabled = true;
                            btn.style.background = "#6c757d";
                        }

                        const response = await fetch('/api/delete', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ pieceCids: pieceCids })
                        });
                        
                        const data = await response.json();
                        if (response.ok) {
                            alert("File removed successfully!");
                            loadHistory(); // Refresh the table
                        } else {
                            alert("Error removing file: " + data.error);
                            if (btn) {
                                btn.innerText = "Delete File";
                                btn.disabled = false;
                                btn.style.background = "#dc3545";
                            }
                        }
                    } catch (err) {
                        alert("Network error: " + err.message);
                    }
                }
                
                // --- Copy Helper ---
                function copyText(text, btnId) {
                    navigator.clipboard.writeText(text).then(() => {
                        const btn = document.getElementById(btnId);
                        const originalText = btn.innerText;
                        btn.innerText = '✅';
                        setTimeout(() => { btn.innerText = originalText; }, 1500);
                    }).catch(err => console.error('Copy failed', err));
                }

                // --- History Fetching Logic with RowSpan Grouping ---
                async function loadHistory() {
                    document.getElementById('paymentsCard').style.display = 'none';
                    document.getElementById('historyCard').style.display = 'block';
                    document.getElementById('historyContent').innerHTML = 'Querying Filecoin Blockchain...';
                    
                    try {
                        const response = await fetch('/api/history');
                        const data = await response.json();

                        if (data.pieces && data.pieces.length === 0) {
                            document.getElementById('historyContent').innerHTML = 'No pieces found in this dataset yet.';
                            return;
                        }

                        let html = \`<div class="table-wrapper"><table>
                            <tr>
                                <th>Original File</th>
                                <th>Root CID</th>
                                <th>Piece CID</th>
                                <th>Size</th>
                                <th>Action</th>
                            </tr>\`;

                        const groups = [];
                        let currentGroup = null;

                        data.pieces.forEach(p => {
                            const hasValidRoot = p.root_cid && p.root_cid !== 'Unknown';
                            if (currentGroup && hasValidRoot && currentGroup.root_cid === p.root_cid) {
                                currentGroup.pieces.push(p);
                            } else {
                                currentGroup = {
                                    root_cid: p.root_cid,
                                    original_file: p.original_file,
                                    hasValidRoot: hasValidRoot,
                                    pieces: [p]
                                };
                                groups.push(currentGroup);
                            }
                        });

                        groups.forEach((g, groupIndex) => {
                            const displayFile = (g.original_file && g.original_file !== 'Unknown') ? g.original_file : 'Unnamed (Legacy Upload)';
                            const rowSpanCount = g.pieces.length;
                            
                            // Create truncated Root CID block
                            let rootHtml = '<span style="color: #999;">N/A</span>';
                            if (g.hasValidRoot) {
                                const fullRoot = g.root_cid;
                                const shortRoot = fullRoot.length > 20 ? fullRoot.substring(0, 14) + '...' + fullRoot.slice(-4) : fullRoot;
                                const btnId = 'copy-root-' + groupIndex;
                                rootHtml = \`
                                <div class="cid-container">
                                    <span title="\${fullRoot}">\${shortRoot}</span>
                                    <button id="\${btnId}" class="copy-btn" onclick="copyText('\${fullRoot}', '\${btnId}')">Copy</button>
                                </div>\`;
                            }
                            
                            const allGroupCids = g.pieces.map(p => p.pieceCid);
                            const cidsJson = JSON.stringify(allGroupCids).replace(/"/g, '&quot;');
                            const deleteBtnId = 'btn-group-' + groupIndex;
                            
                            g.pieces.forEach((p, index) => {
                                const displaySize = (p.size && p.size !== 'Unknown') ? p.size : 'N/A';
                                
                                // Create truncated Piece CID block
                                const fullPiece = p.pieceCid;
                                const shortPiece = fullPiece.length > 20 ? fullPiece.substring(0, 14) + '...' + fullPiece.slice(-4) : fullPiece;
                                const pieceBtnId = 'copy-piece-' + groupIndex + '-' + index;
                                const pieceHtml = \`
                                <div class="cid-container">
                                    <span title="\${fullPiece}">\${shortPiece}</span>
                                    <button id="\${pieceBtnId}" class="copy-btn" onclick="copyText('\${fullPiece}', '\${pieceBtnId}')">Copy</button>
                                </div>\`;
                                
                                html += \`<tr>\`;
                                
                                if (index === 0) {
                                    // Original file can now wrap comfortably because CID columns are small
                                    html += \`<td rowspan="\${rowSpanCount}" class="grouped-cell filename-cell"><strong>\${displayFile}</strong></td>\`;
                                    html += \`<td rowspan="\${rowSpanCount}" class="grouped-cell cid-cell">\${rootHtml}</td>\`;
                                }
                                
                                html += \`<td class="cid-cell">\${pieceHtml}</td>\`;
                                html += \`<td style="white-space: nowrap;">\${displaySize}</td>\`;
                                
                                if (index === 0) {
                                    html += \`<td rowspan="\${rowSpanCount}" class="grouped-cell">
                                        <button id="\${deleteBtnId}" class="delete-btn" onclick="deleteGroup(\${cidsJson}, '\${deleteBtnId}')">Delete File</button>
                                    </td>\`;
                                }
                                
                                html += \`</tr>\`;
                            });
                        });

                        html += \`</table></div>\`;
                        document.getElementById('historyContent').innerHTML = html;

                    } catch (err) {
                        document.getElementById('historyContent').innerHTML = '<span style="color:red;">Error loading history: ' + err.message + '</span>';
                    }
                }
            </script>
        </body>
        </html>
    `);
});

// --- 2. NEW ENDPOINT: FETCH UPLOAD HISTORY (TERMINAL PARSER WITH PAYLOAD CID) ---
app.get('/api/history', async (req, res) => {
    try {
        console.log(`Fetching history for Dataset ${DATASET_ID} via Filecoin-Pin CLI...`);
        
        const { stdout } = await execPromise(`npx filecoin-pin dataset show ${DATASET_ID} --rpc-url ${RPC_URL}`);
        
        const pieces = [];
        let currentPiece = null;

        const lines = stdout.split('\n');
        for (const line of lines) {
            // Strip terminal ANSI color codes and trim whitespace
            const cleanLine = line.replace(/\x1B\[[0-9;]*[mK]/g, '').trim();
            
            // Detect a new Piece block (e.g., "#80 (active)")
            if (cleanLine.startsWith('#')) {
                if (currentPiece && currentPiece.pieceCid !== 'Unknown') {
                    pieces.push(currentPiece);
                }
                currentPiece = { pieceCid: 'Unknown', size: 'Unknown', original_file: 'Unknown', root_cid: 'Unknown' };
            }
            
            if (currentPiece) {
                // Aggressively capture all variants of CID and Metadata from the CLI tree
                if (cleanLine.includes('PieceCID:')) {
                    currentPiece.pieceCid = cleanLine.split('PieceCID:')[1].trim();
                } else if (cleanLine.includes('Size:')) {
                    currentPiece.size = cleanLine.split('Size:')[1].trim();
                } else if (cleanLine.includes('PayloadCID:')) {
                    currentPiece.root_cid = cleanLine.split('PayloadCID:')[1].replace(/["']/g, '').trim();
                } else if (cleanLine.includes('RootCID:')) {
                    currentPiece.root_cid = cleanLine.split('RootCID:')[1].replace(/["']/g, '').trim();
                } else if (cleanLine.includes('original_file:')) {
                    currentPiece.original_file = cleanLine.split('original_file:')[1].replace(/["']/g, '').trim();
                } else if (cleanLine.includes('name:') && currentPiece.original_file === 'Unknown') {
                    currentPiece.original_file = cleanLine.split('name:')[1].replace(/["']/g, '').trim();
                } else if (cleanLine.includes('root_cid:')) {
                    currentPiece.root_cid = cleanLine.split('root_cid:')[1].replace(/["']/g, '').trim();
                }
            }
        }
        
        // Push the very last piece in the loop
        if (currentPiece && currentPiece.pieceCid !== 'Unknown') {
            pieces.push(currentPiece);
        }

        res.json({
            datasetId: DATASET_ID,
            pieces: pieces.reverse() 
        });

    } catch (error) {
        console.error("Error fetching history via CLI:", error);
        res.status(500).json({ error: "Could not fetch dataset. Make sure you have uploaded at least one file." });
    }
});


// --- 3. BACKEND UPLOAD HANDLER ---
app.post('/upload-target', upload.array('files'), (req, res) => {
    if (!req.files || req.files.length === 0) return res.status(400).send('No files.');

    const jobId = Date.now().toString();
    const tempJobFolder = path.join(uploadDir, `job_${jobId}`);
    
    fs.mkdirSync(tempJobFolder);

    const paths = [].concat(req.body.paths || []);
    
    req.files.forEach((file, index) => {
        const relativePath = paths[index];
        const fullDestPath = path.join(tempJobFolder, relativePath);
        
        fs.mkdirSync(path.dirname(fullDestPath), { recursive: true });
        fs.renameSync(file.path, fullDestPath);
    });

    const rootTargetName = paths[0].split('/')[0]; 
    const pathToPack = path.join(tempJobFolder, rootTargetName);

    activeJobs.set(jobId, { res: null });
    res.json({ jobId });

    runPipeline(jobId, pathToPack, rootTargetName, tempJobFolder).catch(console.error);
});

// --- 4. SSE STATUS ENDPOINT ---
app.get('/status/:jobId', (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    const job = activeJobs.get(req.params.jobId);
    if (job) job.res = res;
});

// --- 5. THE PIPELINE RUNNER (WITH FILECOIN PADDING OPTIMIZATION) ---
async function runPipeline(jobId, pathToPack, rootTargetName, tempJobFolder) {
    const sendEvent = (event, data) => {
        const job = activeJobs.get(jobId);
        if (job && job.res) job.res.write(`event: ${event}\ndata: ${data}\n\n`);
    };

    const carFilePath = path.join(tempJobFolder, `${rootTargetName}.car`);

    try {
        sendEvent('packing', 'start');
        
        const { stdout } = await execPromise(`npx ipfs-car p "${pathToPack}" -o "${carFilePath}"`);
        
        const rootCidMatch = stdout.trim().split('\n').pop();
        if (rootCidMatch) {
            sendEvent('root_cid', rootCidMatch);
        }

        sendEvent('packing', 'done');

        const carFileSize = fs.statSync(carFilePath).size;
        let filesToUpload = [];

        // Dynamic Filecoin Padding Optimization Algorithm
        let optimalChunkSize = MAX_CAR_SIZE; // Default max is 1 GiB
        
        if (carFileSize <= MAX_CAR_SIZE) {
            sendEvent('splitting', 'skipped');
            filesToUpload.push(`${rootTargetName}.car`);
        } else {
            sendEvent('splitting', 'start');
            
            // We want pieces between 32MiB and 1GiB
            const minBoundary = 32 * 1024 * 1024; 
            let bestBoundary = MAX_CAR_SIZE;
            let lowestWaste = Infinity;

            for (let boundary = MAX_CAR_SIZE; boundary >= minBoundary; boundary /= 2) {
                const chunksNeeded = Math.ceil(carFileSize / boundary);
                const finalChunkSize = carFileSize % boundary || boundary;
                
                // Network pads the final chunk to the NEXT power of 2
                let finalChunkPaddedSize = minBoundary;
                while (finalChunkPaddedSize < finalChunkSize) {
                    finalChunkPaddedSize *= 2;
                }
                
                const wastedPadding = finalChunkPaddedSize - finalChunkSize;

                if (wastedPadding < lowestWaste) {
                    lowestWaste = wastedPadding;
                    bestBoundary = boundary;
                }
            }

            optimalChunkSize = bestBoundary;
            console.log(`[Job ${jobId}] File Size: ${carFileSize} bytes. Optimal Chunk Size: ${optimalChunkSize} bytes.`);

            // Pass the calculated optimal byte size directly to carbites
            await execPromise(`npx carbites split "${carFilePath}" --size ${optimalChunkSize} --strategy treewalk`, { cwd: tempJobFolder });
            sendEvent('splitting', 'done');

            filesToUpload = fs.readdirSync(tempJobFolder)
                .filter(f => f.endsWith('.car') && f !== `${rootTargetName}.car`)
                .sort();
        }

        sendEvent('chunk_init', filesToUpload.length);

        const synapse = await Synapse.create({ chain: mainnet, account: privateKeyToAccount(PRIVATE_KEY) });

        for (let i = 0; i < filesToUpload.length; i++) {
            const uploadPath = path.join(tempJobFolder, filesToUpload[i]);
            const totalSize = fs.statSync(uploadPath).size;
            
            const nodeStream = fs.createReadStream(uploadPath);
            const webStream = Readable.toWeb(nodeStream);

            const uploadTask = await synapse.storage.upload(webStream, {
                count: 2, 
                isCar: true, 
                dataSetIds: [BigInt(DATASET_ID)], 
                pieceMetadata: { 
                    name: filesToUpload[i].substring(0, 32),
                    original_file: rootTargetName.substring(0, 32),
                    size_bytes: totalSize.toString(),
                    root_cid: rootCidMatch || 'unknown'
                },
                callbacks: {
                    onProgress: (bytes) => {
                        const pct = Math.min(100, Math.round((bytes / totalSize) * 100));
                        sendEvent('chunk_progress', JSON.stringify({ index: i, pct }));
                    }
                }
            });

            let actualCid = "Unknown CID";
            if (typeof uploadTask === 'string') {
                actualCid = uploadTask;
            } else if (uploadTask && uploadTask.pieceCid) {
                actualCid = uploadTask.pieceCid.toString();
            } else if (uploadTask && uploadTask.copies && uploadTask.copies.length > 0) {
                actualCid = uploadTask.copies[0].pieceCid.toString();
            } else if (uploadTask && typeof uploadTask.toString === 'function') {
                actualCid = uploadTask.toString();
            }

            sendEvent('chunk_done', JSON.stringify({ index: i, cid: actualCid }));
        }

        sendEvent('done', 'success');

    } catch (error) {
        console.error("Pipeline failed:", error);
    } finally {
        fs.rmSync(tempJobFolder, { recursive: true, force: true });
        activeJobs.delete(jobId);
    }
}

// --- 6. NEW ENDPOINT: REMOVE GROUPED PIECES VIA CLI ---
app.post('/api/delete', async (req, res) => {
    const { pieceCids } = req.body;
    
    if (!pieceCids || !Array.isArray(pieceCids) || pieceCids.length === 0) {
        return res.status(400).json({ error: "No Piece CIDs provided." });
    }

    try {
        console.log(`Removing ${pieceCids.length} piece(s) from Dataset ${DATASET_ID}...`);
        
        for (let i = 0; i < pieceCids.length; i++) {
            const pieceCid = pieceCids[i];
            console.log(`[${i+1}/${pieceCids.length}] Removing Piece ${pieceCid}...`);
            
            const command = `npx filecoin-pin rm --piece ${pieceCid} --data-set ${DATASET_ID} --private-key ${PRIVATE_KEY} --rpc-url ${RPC_URL} --wait-for-confirmation`;
            
            const { stdout } = await execPromise(command);
            console.log(`Output for ${pieceCid}:`, stdout);
        }
        
        res.json({ success: true, message: `Removed ${pieceCids.length} pieces.` });
        
    } catch (error) {
        console.error("Error removing pieces:", error);
        res.status(500).json({ error: "Failed to remove one or more pieces. Check server logs for details." });
    }
});

// --- 7. NEW ENDPOINT: CHECK PAYMENTS STATUS ---
app.get('/api/payments', async (req, res) => {
    try {
        console.log(`Fetching payments status...`);
        // Use the exact CLI command requested by the user, injecting the private key automatically
        const command = `npx filecoin-pin payments status --private-key ${PRIVATE_KEY} --rpc-url ${RPC_URL}`;
        
        const { stdout } = await execPromise(command);
        
        // Strip terminal color codes before sending to frontend
        const cleanText = stdout.replace(/\x1B\[[0-9;]*[mK]/g, '');
        
        res.json({ success: true, output: cleanText });
        
    } catch (error) {
        console.error("Error fetching payments:", error);
        
        // Sometimes the CLI throws an error but the text we want is inside stderr
        let errorOutput = error.message;
        if (error.stderr) {
            errorOutput = error.stderr.replace(/\x1B\[[0-9;]*[mK]/g, '');
        }
        
        res.status(500).json({ error: errorOutput });
    }
});

app.listen(port, () => console.log(`Smart Uploader (v4) running at http://localhost:${port} (Dataset: ${DATASET_ID})`));
